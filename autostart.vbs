' Mo Writer - silent launcher for the background service
' Runs run-loop.bat with no visible window. Paths come from this file's own
' location, so the whole folder can be moved without editing anything.

Option Explicit

Dim fso, ROOT, sh
Set fso = CreateObject("Scripting.FileSystemObject")
ROOT = fso.GetParentFolderName(WScript.ScriptFullName)

Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = ROOT
sh.Run """" & ROOT & "\run-loop.bat""", 0, False
Set sh = Nothing
