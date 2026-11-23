; Electron user data and updater downloads leave with the application; the Harness home is never touched.
!include FileFunc.nsh
Var UnTarget
Var UnHome
Var UnFailures
Var UnReport

; Append one failed cleanup target and its Win32 code to the report, creating the file on first failure.
; The uninstaller keeps its result code (residue never fails the uninstall) but no longer drops the reason.
!macro UnRecordFailure Target Code
  IntOp $UnFailures $UnFailures + 1
  ${If} $UnReport == ""
    ; GetTime yields zero-padded day, month, year, weekday, hour, minute, second.
    ${GetTime} "" "L" $R2 $R3 $R4 $R5 $R6 $R7 $R8
    StrCpy $UnReport "$TEMP\${PRODUCT_FILENAME}-uninstall-report-$R4$R3$R2-$R6$R7$R8.txt"
    FileOpen $R9 "$UnReport" w
    FileWriteUTF16LE $R9 "$(^Name) uninstall report$\r$\n"
    FileWriteUTF16LE $R9 "These locations could not be removed completely. Locked files stay on disk.$\r$\n$\r$\n"
    FileWriteUTF16LE $R9 "  ${Target}  (Win32 error ${Code})$\r$\n"
    FileClose $R9
  ${Else}
    FileOpen $R9 "$UnReport" a
    FileWriteUTF16LE $R9 "  ${Target}  (Win32 error ${Code})$\r$\n"
    FileClose $R9
  ${EndIf}
!macroend

; The helper refuses unsafe roots, the installation and the Harness home, and never descends into reparse points;
; a locked file leaves residue and never fails the uninstall. customCheckAppRunning extracts window-frame.dll first.
Function un.RemoveData
  System::Call '$PLUGINSDIR\window-frame.dll::UninstallRemoveData(w "$UnTarget", w "$INSTDIR", w "$UnHome") i.r0'
  ${If} $0 != 0
    !insertmacro UnRecordFailure "$UnTarget" "$0"
  ${EndIf}
FunctionEnd

; Surface cleanup residue once: the report path reaches the details view, and interactive uninstalls also show it.
Function un.ReportFailures
  ${If} $UnFailures == 0
    Return
  ${EndIf}
  DetailPrint "Some application data could not be removed; locked files stay on disk."
  DetailPrint "Report: $UnReport"
  ${If} ${Silent}
    DetailPrint "Uninstall report: $UnReport"
  ${Else}
    MessageBox MB_OK|MB_ICONEXCLAMATION "Some application data could not be removed and may still be on this PC.$\r$\n$\r$\nA report was saved to:$\r$\n$UnReport" /SD IDOK
  ${EndIf}
FunctionEnd

Function un.CleanData
  ${If} ${isUpdated}
    Return
  ${EndIf}
  ; The installer runs an older uninstaller with /KEEP_APP_DATA when replacing it from another directory.
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/KEEP_APP_DATA" $R1
  ${IfNot} ${Errors}
    Return
  ${EndIf}
  ; Only a DSH_HOME published as a Windows environment variable is visible here.
  ReadEnvStr $UnHome DSH_HOME
  ClearErrors
  StrCpy $UnTarget "$APPDATA\${PRODUCT_FILENAME}"
  Call un.RemoveData
  !ifdef APP_PACKAGE_NAME
    ; Electron derives user data from the package name; a scoped name nests it one directory deeper.
    StrCpy $UnTarget "$APPDATA\${APP_PACKAGE_NAME}"
    Call un.RemoveData
    System::Call '$PLUGINSDIR\window-frame.dll::UninstallRemoveEmptyParents(w "$UnTarget", w "$APPDATA") i.r0'
    ${If} $0 != 0
      !insertmacro UnRecordFailure "$APPDATA\${APP_PACKAGE_NAME} (empty parents)" "$0"
    ${EndIf}
  !endif
  StrCpy $UnTarget "$LOCALAPPDATA\${DSH_UPDATER_CACHE_NAME}"
  Call un.RemoveData
  Call un.ReportFailures
FunctionEnd
