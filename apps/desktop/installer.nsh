; Windows uninstaller (roadmap A1, D-050): remove the start-at-sign-in entry the app created
; (apps/cli/src/autostart.ts writes HKCU\...\Run "Rocky"). The data folder is left in place.
!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Rocky"
!macroend
