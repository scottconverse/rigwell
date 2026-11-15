!macro customInstall
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
