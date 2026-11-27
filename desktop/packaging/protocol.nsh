!macro customInstall
  ; The unpack step can be blocked (Smart App Control blocks unsigned plugin dlls; antivirus can too).
  ; NSIS then goes on and reports success with an empty folder. Stop with an error instead,
  ; and remove the entries this run already wrote, so no broken shortcut or uninstall entry stays.
  ${IfNot} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    Delete "$newStartMenuLink"
    Delete "$newDesktopLink"
    Delete "$INSTDIR\${UNINSTALL_FILENAME}"
    DeleteRegKey SHCTX "${UNINSTALL_REGISTRY_KEY}"
    !ifdef UNINSTALL_REGISTRY_KEY_2
      DeleteRegKey SHCTX "${UNINSTALL_REGISTRY_KEY_2}"
    !endif
    DeleteRegKey SHCTX "${INSTALL_REGISTRY_KEY}"
    RMDir "$INSTDIR"
    MessageBox MB_OK|MB_ICONSTOP "Rigwell could not be installed: Windows blocked or removed the program files while they were unpacked. Nothing was installed." /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
  ; NSIS does not consume electron-builder's protocols configuration.
  ; Register before first launch, in this installation's shell context.
  WriteRegStr SHCTX "Software\Classes\rigwell" "" "URL:Rigwell Protocol"
  WriteRegStr SHCTX "Software\Classes\rigwell" "URL Protocol" ""
  WriteRegStr SHCTX "Software\Classes\rigwell\DefaultIcon" "" '"$INSTDIR\rigwell.exe",0'
  WriteRegStr SHCTX "Software\Classes\rigwell\shell\open\command" "" '"$INSTDIR\rigwell.exe" "%1"'
!macroend

!macro customUnInstall
  ; An older install must not remove a handler now owned by another copy.
  Push $0
  ReadRegStr $0 SHCTX "Software\Classes\rigwell\shell\open\command" ""
  ${If} $0 == '"$INSTDIR\rigwell.exe" "%1"'
    DeleteRegKey SHCTX "Software\Classes\rigwell"
  ${EndIf}
  Pop $0
!macroend
