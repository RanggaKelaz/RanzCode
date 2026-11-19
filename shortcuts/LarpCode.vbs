' LarpCode direct-launch shortcut.
'
' Fires the installed Electron binary straight at the desktop-pkg directory,
' no PowerShell chain, no Tor rotation, no DB wipe. This is what the Start
' Menu + Desktop "LarpCode" shortcuts point at, so a normal launch takes ~5s
' (integrity-bootstrap + window paint) instead of the full reset ritual.
'
' For the deliberate "reset my usage" workflow, use the Reset pill inside
' the app. It runs the reset in-process (session backup, local wipe, identity
' and egress rotation) and reloads. This .vbs is intentionally dumb - it just
' spawns Electron.
'
' Routed from:
'   (a) Start Menu "LarpCode" shortcut
'   (b) Desktop "LarpCode" shortcut (if the user ticked that box)
'   (c) Installer's post-install "Launch LarpCode now" option

Option Explicit
Dim shell, scriptFullName, scriptDir, appRoot, electronExe, desktopPkg
Set shell = CreateObject("WScript.Shell")
scriptFullName = WScript.ScriptFullName
scriptDir = Left(scriptFullName, InStrRev(scriptFullName, "\"))
' shortcuts/ sits next to electron/ and desktop-pkg/ under the install root.
appRoot = Left(scriptDir, Len(scriptDir) - Len("shortcuts\"))
electronExe = appRoot & "electron\electron.exe"
desktopPkg = appRoot & "desktop-pkg"

' Window style 1 = SW_SHOWNORMAL so the Electron window is visible when it
' paints. bWaitOnReturn=False so this .vbs exits immediately and no orphan
' wscript hangs around.
shell.Run """" & electronExe & """ """ & desktopPkg & """", 1, False
