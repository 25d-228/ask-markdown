// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "ask-markdown" is now active!');

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	context.subscriptions.push(
		vscode.commands.registerCommand('ask-markdown.openPreview', () => {
			vscode.window.showInformationMessage('Ask Markdown: Open Preview (not implemented yet)');
		}),
		vscode.commands.registerCommand('ask-markdown.askAboutSelection', () => {
			vscode.window.showInformationMessage('Ask Markdown: Ask About Selection (not implemented yet)');
		}),
	);
}

// This method is called when your extension is deactivated
export function deactivate() {}
