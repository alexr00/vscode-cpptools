/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All Rights Reserved.
 * See 'LICENSE' in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as path from 'path';
import * as vscode from 'vscode';
import * as os from 'os';
import * as util from '../common';
import * as telemetry from '../telemetry';
import { Client } from './client';
import * as configs from './configurations';
import * as ext from './extension';
import * as fs from 'fs';
import * as nls from 'vscode-nls';
import * as cp from "child_process";
import { OtherSettings } from './settings';
import * as jsonc from 'jsonc-parser';

const localize: nls.LocalizeFunc = nls.loadMessageBundle();
export const failedToParseTasksJson: string = localize("failed.to.parse.tasks", "Failed to parse tasks.json, possibly due to comments or trailing commas.");

export interface CppBuildTaskDefinition extends vscode.TaskDefinition {
    type: string;
    label: string;
    command: string;
    args: string[];
    options: cp.ExecOptions | undefined;
}

export class CppBuildTaskProvider implements vscode.TaskProvider {
    static CppBuildScriptType: string = 'cppbuild';
    static CppBuildSourceStr: string = "C/C++";
    private tasks: vscode.Task[] | undefined;

    constructor() {}

    public async provideTasks(): Promise<vscode.Task[]> {
        if (this.tasks) {
            return this.tasks;
        }
        return this.getTasks(false);
    }

    // Resolves a task that has no [`execution`](#Task.execution) set.
    public resolveTask(_task: vscode.Task): vscode.Task | undefined {
        const execution: vscode.ProcessExecution | vscode.ShellExecution | vscode.CustomExecution | undefined = _task.execution;
        if (!execution) {
            const definition: CppBuildTaskDefinition = <any>_task.definition;
            return this.getTask(definition.command, false, definition.args ? definition.args : [], definition);
        }
        return undefined;
    }

    // Generate tasks to build the current file based on the user's detected compilers, the user's compilerPath setting, and the current file's extension.
    public async getTasks(appendSourceToName: boolean): Promise<vscode.Task[]> {
        if (this.tasks !== undefined) {
            return this.tasks;
        }
        const editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor;
        if (!editor) {
            return [];
        }

        const fileExt: string = path.extname(editor.document.fileName);
        if (!fileExt) {
            return [];
        }

        // Don't offer tasks for header files.
        const fileExtLower: string = fileExt.toLowerCase();
        const isHeader: boolean = !fileExt || [".hpp", ".hh", ".hxx", ".h++", ".hp", ".h", ".ii", ".inl", ".idl", ""].some(ext => fileExtLower === ext);
        if (isHeader) {
            return [];
        }

        // Don't offer tasks if the active file's extension is not a recognized C/C++ extension.
        let fileIsCpp: boolean;
        let fileIsC: boolean;
        if (fileExt === ".C") { // ".C" file extensions are both C and C++.
            fileIsCpp = true;
            fileIsC = true;
        } else {
            fileIsCpp = [".cpp", ".cc", ".cxx", ".c++", ".cp", ".ino", ".ipp", ".tcc"].some(ext => fileExtLower === ext);
            fileIsC = fileExtLower === ".c";
        }
        if (!(fileIsCpp || fileIsC)) {
            return [];
        }

        // Get compiler paths.
        const isWindows: boolean = os.platform() === 'win32';
        let activeClient: Client;
        try {
            activeClient = ext.getActiveClient();
        } catch (e) {
            if (!e || e.message !== ext.intelliSenseDisabledError) {
                console.error("Unknown error calling getActiveClient().");
            }
            return []; // Language service features may be disabled.
        }

        // Get user compiler path.
        const userCompilerPathAndArgs: util.CompilerPathAndArgs | undefined = await activeClient.getCurrentCompilerPathAndArgs();
        let userCompilerPath: string | undefined;
        if (userCompilerPathAndArgs) {
            userCompilerPath = userCompilerPathAndArgs.compilerPath;
            if (userCompilerPath && userCompilerPathAndArgs.compilerName) {
                userCompilerPath = userCompilerPath.trim();
                if (isWindows && userCompilerPath.startsWith("/")) { // TODO: Add WSL compiler support.
                    userCompilerPath = undefined;
                } else {
                    userCompilerPath = userCompilerPath.replace(/\\\\/g, "\\");
                }
            }
        }

        // Get known compiler paths. Do not include the known compiler path that is the same as user compiler path.
        // Filter them based on the file type to get a reduced list appropriate for the active file.
        let knownCompilerPaths: string[] | undefined;
        let knownCompilers: configs.KnownCompiler[]  | undefined = await activeClient.getKnownCompilers();
        if (knownCompilers) {
            knownCompilers = knownCompilers.filter(info =>
                ((fileIsCpp && !info.isC) || (fileIsC && info.isC)) &&
                    userCompilerPathAndArgs &&
                    (path.basename(info.path) !== userCompilerPathAndArgs.compilerName) &&
                    (!isWindows || !info.path.startsWith("/"))); // TODO: Add WSL compiler support.
            knownCompilerPaths = knownCompilers.map<string>(info => info.path);
        }

        if (!knownCompilerPaths && !userCompilerPath) {
            // Don't prompt a message yet until we can make a data-based decision.
            telemetry.logLanguageServerEvent('noCompilerFound');
            return [];
        }

        // Create a build task per compiler path
        this.tasks = [];
        // Tasks for known compiler paths
        if (knownCompilerPaths) {
            this.tasks  = knownCompilerPaths.map<vscode.Task>(compilerPath => this.getTask(compilerPath, appendSourceToName, undefined));
        }
        // Task for user compiler path setting
        if (userCompilerPath) {
            this.tasks.push(this.getTask(userCompilerPath, appendSourceToName, userCompilerPathAndArgs?.additionalArgs));
        }

        return this.tasks;
    }

    private getTask: (compilerPath: string, appendSourceToName: boolean, compilerArgs?: string [], definition?: CppBuildTaskDefinition) => vscode.Task = (compilerPath: string, appendSourceToName: boolean, compilerArgs?: string [], definition?: CppBuildTaskDefinition) => {
        const filePath: string = path.join('${fileDirname}', '${fileBasenameNoExtension}');
        const compilerPathBase: string = path.basename(compilerPath);
        const taskName: string = (appendSourceToName ? CppBuildTaskProvider.CppBuildSourceStr + ": " : "") + compilerPathBase + " build active file";
        const isCl: boolean = compilerPathBase === "cl.exe";
        const isWindows: boolean = os.platform() === 'win32';
        const cwd: string = isCl ? "${workspaceFolder}" : path.dirname(compilerPath);
        let args: string[] = isCl ? ['/Zi', '/EHsc', '/Fe:', filePath + '.exe', '${file}'] : ['-g', '${file}', '-o', filePath + (isWindows ? '.exe' : '')];
        if (!definition && compilerArgs && compilerArgs.length > 0) {
            args = args.concat(compilerArgs);
        }
        const options: cp.ExecOptions | undefined = {cwd: cwd};

        // Double-quote the command if it is not already double-quoted.
        let resolvedcompilerPath: string = isCl ? compilerPathBase : compilerPath;
        if (resolvedcompilerPath && !resolvedcompilerPath.startsWith("\"") && resolvedcompilerPath.includes(" ")) {
            resolvedcompilerPath = "\"" + resolvedcompilerPath + "\"";
        }

        if (!definition) {
            definition = {
                type: CppBuildTaskProvider.CppBuildScriptType,
                label: taskName,
                command: resolvedcompilerPath,
                args: args,
                options: options
            };
        }

        const activeClient: Client = ext.getActiveClient();
        const uri: vscode.Uri | undefined = activeClient.RootUri;
        if (!uri) {
            throw new Error("No client URI found in getBuildTasks()");
        }
        const target: vscode.WorkspaceFolder | undefined = vscode.workspace.getWorkspaceFolder(uri);
        if (!target) {
            throw new Error("No target WorkspaceFolder found in getBuildTasks()");
        }

        const task: vscode.Task =  new vscode.Task(definition, target, taskName, CppBuildTaskProvider.CppBuildSourceStr,
            new vscode.CustomExecution(async (): Promise<vscode.Pseudoterminal> =>
            // When the task is executed, this callback will run. Here, we setup for running the task.
			 new CustomBuildTaskTerminal(resolvedcompilerPath, args, options, target.name)
            ), isCl ? '$msCompile' : '$gcc');

        task.group = vscode.TaskGroup.Build;

        return task;
    };

    async ensureBuildTaskExists(taskName: string): Promise<void> {
        const rawTasksJson: any = await getRawTasksJson();

        // Ensure that the task exists in the user's task.json. Task will not be found otherwise.
        if (!rawTasksJson.tasks) {
            rawTasksJson.tasks = new Array();
        }
        // Find or create the task which should be created based on the selected "debug configuration".
        let selectedTask: vscode.Task | undefined = rawTasksJson.tasks.find((task: any) => task.label && task.label === taskName);
        if (selectedTask) {
            return;
        }

        const buildTasks: vscode.Task[] = await this.getTasks(true);
        selectedTask = buildTasks.find(task => task.name === taskName);
        console.assert(selectedTask);
        if (!selectedTask) {
            throw new Error("Failed to get selectedTask in ensureBuildTaskExists()");
        }

        rawTasksJson.version = "2.0.0";

        const selectedTask2: vscode.Task = selectedTask;
        if (!rawTasksJson.tasks.find((task: any) => task.label === selectedTask2.definition.label)) {
            const task: any = {
                ...selectedTask2.definition,
                problemMatcher: selectedTask2.problemMatchers,
                group: { kind: "build", "isDefault": true }
            };
            rawTasksJson.tasks.push(task);
        }

        // TODO: It's dangerous to overwrite this file. We could be wiping out comments.
        const settings: OtherSettings = new OtherSettings();
        const tasksJsonPath: string | undefined = getTasksJsonPath();
        if (!tasksJsonPath) {
            throw new Error("Failed to get tasksJsonPath in ensureBuildTaskExists()");
        }

        await util.writeFileText(tasksJsonPath, JSON.stringify(rawTasksJson, null, settings.editorTabSize));
    }
}

class CustomBuildTaskTerminal implements vscode.Pseudoterminal {
    private writeEmitter  = new vscode.EventEmitter<string>();
    private closeEmitter = new vscode.EventEmitter<number>();
    public get onDidWrite(): vscode.Event<string> { return this.writeEmitter.event; }
    public get onDidClose(): vscode.Event<number> { return this.closeEmitter.event; }

    private fileWatcher: vscode.FileSystemWatcher | undefined;


    constructor(private command: string, private args: string[], private options: cp.ExecOptions | undefined, private workspaceRoot: string) {
    }


    open(_initialDimensions: vscode.TerminalDimensions | undefined): void {
        telemetry.logLanguageServerEvent("cppBuildTaskStarted");
        const pattern: string = path.join(this.workspaceRoot, 'cppBuild');
        this.fileWatcher = vscode.workspace.createFileSystemWatcher(pattern);
        this.fileWatcher.onDidChange(() => this.doBuild());
        this.fileWatcher.onDidCreate(() => this.doBuild());
        this.fileWatcher.onDidDelete(() => this.doBuild());
        // At this point we can start using the terminal.
        this.writeEmitter.fire("Starting build...\r\n");
        this.doBuild();
    }

    close(): void {
        // The terminal has been closed. Shutdown the build.
        if (this.fileWatcher) {
            this.fileWatcher.dispose();
        }
    }

    private async doBuild(): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            // Do build.
            let activeCommand: string = util.resolveVariables(this.command, this.AdditionalEnvironment);
            this.args.forEach(value => {
                let temp: string = util.resolveVariables(value, this.AdditionalEnvironment);
                if (temp && temp.includes(" ")) {
                    temp = "\"" + temp + "\"";
                }
                activeCommand = activeCommand + " " + temp;
            });
            if (this.options?.cwd) {
                this.options.cwd = util.resolveVariables(this.options.cwd, this.AdditionalEnvironment);
            }
            cp.exec(activeCommand, this.options, (_error, stdout, _stderr) => {
                if (_error) {
                    telemetry.logLanguageServerEvent("cppBuildTaskError", { "error": _error.message });
                    this.writeEmitter.fire("Build finished with error:\r\n");
                    this.writeEmitter.fire(stdout.toString());
                    reject();
                } else {
                    this.writeEmitter.fire(stdout.toString());
                    this.writeEmitter.fire("\r\nBuild finished successfully.\r\n");
                    resolve();
                }
            });
        }).finally (() => {
            this.closeEmitter.fire(0);
        });
    }

    private get AdditionalEnvironment(): { [key: string]: string | string[] } | undefined {

        const editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor;
        if (!editor) {
            return undefined;
        }
        const fileDir: vscode.WorkspaceFolder | undefined = vscode.workspace.getWorkspaceFolder(editor.document.uri);
        if (!fileDir) {
            return undefined;
        }
        const file: string = editor.document.fileName;
        return {
            "file": file,
            "fileDirname": fileDir.uri.fsPath,
            "fileBasenameNoExtension": path.parse(file).name,
            "workspaceFolder": fileDir.uri.fsPath};
    }
}

export function getRawTasksJson(): Promise<any> {
    return new Promise<any>((resolve, reject) => {
        const path: string | undefined = getTasksJsonPath();
        if (!path) {
            return resolve({});
        }
        fs.exists(path, async exists => {
            if (!exists) {
                return resolve({});
            }
            const fileContents: string = await util.readFileText(path);
            let rawTasks: any = {};
            try {
                rawTasks = jsonc.parse(fileContents);
            } catch (error) {
                return reject(new Error(failedToParseTasksJson));
            }
            resolve(rawTasks);
        });
    });
}

export function getTasksJsonPath(): string | undefined {
    const editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor;
    if (!editor) {
        return undefined;
    }
    const folder: vscode.WorkspaceFolder | undefined = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (!folder) {
        return undefined;
    }
    return path.join(folder.uri.fsPath, ".vscode", "tasks.json");
}
