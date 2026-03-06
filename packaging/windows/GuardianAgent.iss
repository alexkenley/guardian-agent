#define MyAppName "GuardianAgent"
#ifndef AppVersion
  #define AppVersion "0.0.0-dev"
#endif
#ifndef SourceDir
  #define SourceDir "..\\..\\build\\windows\\app"
#endif

[Setup]
AppId={{C6B2E8D3-74B7-4EF6-9D17-43F7F42B0B63}
AppName={#MyAppName}
AppVersion={#AppVersion}
AppPublisher=GuardianAgent
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableDirPage=no
DisableProgramGroupPage=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
Compression=lzma
SolidCompression=yes
WizardStyle=modern
OutputDir=..\..\build\windows\installer
OutputBaseFilename=GuardianAgent-setup-{#AppVersion}
PrivilegesRequired=lowest

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional shortcuts:"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: recursesubdirs ignoreversion

[Icons]
Name: "{group}\GuardianAgent"; Filename: "{app}\guardianagent.cmd"
Name: "{autodesktop}\GuardianAgent"; Filename: "{app}\guardianagent.cmd"; Tasks: desktopicon

[Run]
Filename: "{app}\guardianagent.cmd"; Description: "Launch GuardianAgent"; Flags: nowait postinstall skipifsilent
