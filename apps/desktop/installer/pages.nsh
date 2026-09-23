; Native introduction, welcome and finish pages for the electron-builder installer.
!ifndef HARNESS_INSTALLER_UI
!define HARNESS_INSTALLER_UI
!define WM_NOTIFY_OUTER_NEXT 0x408

Var InstallerDialog
Var InstallerPhase
Var InstallerDpi
Var InstallerSize
Var InstallerImage
Var InstallerButton
Var InstallerStatus
Var InstallerFont
Var InstallerSmallFont
Var InstallerTitleFont
Var InstallerChoose
Var InstallerEdit
Var InstallerEditFrame
Var InstallerBrowse
Var InstallerLaunch
Var InstallerExpanded
Var InstallerBrandY
Var InstallerPresented
Var InstallerGuideStep
Var InstallerGuideCaption
Var InstallerGuideTitle
Var InstallerGuideLine1
Var InstallerGuideLine2
Var InstallerGuideLine3
Var InstallerGuideBack
Var InstallerGuideNext
!include "${__FILEDIR__}\path.nsh"
!include "${__FILEDIR__}\drawing.nsh"

; All layout values are 96-DPI logical pixels.
!macro InstallerPlace HWND X Y W H
    System::Call 'kernel32::MulDiv(i ${X}, i $InstallerDpi, i 96) i.r0'
    System::Call 'kernel32::MulDiv(i ${Y}, i $InstallerDpi, i 96) i.r1'
    System::Call 'kernel32::MulDiv(i ${W}, i $InstallerDpi, i 96) i.r2'
    System::Call 'kernel32::MulDiv(i ${H}, i $InstallerDpi, i 96) i.r3'
    System::Call 'user32::MoveWindow(p ${HWND}, i r0, i r1, i r2, i r3, i 1)'
!macroend

; One introduction step replaces its text block without re-creating controls.
!macro InstallerGuideText HANDLE STEP1 STEP2 STEP3
    ${If} $InstallerGuideStep == 1
        ${NSD_SetText} ${HANDLE} "${STEP1}"
    ${ElseIf} $InstallerGuideStep == 2
        ${NSD_SetText} ${HANDLE} "${STEP2}"
    ${Else}
        ${NSD_SetText} ${HANDLE} "${STEP3}"
    ${EndIf}
!macroend

; Body lines stack from the first slot; $R0 keeps the calculated offset off the caller's registers.
; Each step rewrites these lines, so they paint the page background over the previous step.
!macro InstallerGuideLine HANDLE INDEX
    ${NSD_CreateLabel} 0 0 0 0 ""
    Pop ${HANDLE}
    StrCpy $R0 ${INDEX}
    IntOp $R0 $R0 * ${INSTALLER_GUIDE_BODY_GAP}
    IntOp $R0 $R0 + ${INSTALLER_GUIDE_BODY_Y}
    !insertmacro InstallerPlace ${HANDLE} ${INSTALLER_GUIDE_TEXT_X} $R0 ${INSTALLER_GUIDE_TEXT_WIDTH} ${INSTALLER_GUIDE_BODY_HEIGHT}
    ${NSD_AddStyle} ${HANDLE} ${SS_CENTER}|${SS_CENTERIMAGE}
    SendMessage ${HANDLE} ${WM_SETFONT} $InstallerSmallFont 1
    !insertmacro InstallerCaptionColors ${HANDLE} ${INSTALLER_BACKGROUND_LIGHT} ${INSTALLER_BACKGROUND_DARK}
!macroend

; Every page of the frameless window shares the drag area, title buttons, brand bitmap and caption.
Function InstallerCreateShell
    nsDialogs::Create 1018
    Pop $InstallerDialog
    ${If} $InstallerDialog == error
        Abort
    ${EndIf}
    !insertmacro InstallerPlace $InstallerDialog 0 0 ${INSTALLER_WINDOW_SIZE} ${INSTALLER_WINDOW_SIZE}
    !insertmacro InstallerControlColors $HWNDPARENT
    !insertmacro InstallerControlColors $InstallerDialog
    !insertmacro InstallerPixelFont $InstallerFont ${INSTALLER_BUTTON_FONT_SIZE} 500
    !insertmacro InstallerPixelFont $InstallerSmallFont ${INSTALLER_STATUS_FONT_SIZE} 400
    !insertmacro InstallerPixelFont $InstallerTitleFont ${INSTALLER_GUIDE_TITLE_FONT_SIZE} 500
    System::Call '*(i 1, p 0, i 0, i 0) p.r0'
    System::Call 'gdiplus::GdiplusStartup(*p .r1, p r0, p 0) i.r2'
    StrCpy $InstallerGdiToken $1
    System::Free $0
    ${If} $2 != 0
        MessageBox MB_OK|MB_ICONSTOP "$(INSTALLER_UI_ERROR)"
        SetErrorLevel 2
        Quit
    ${EndIf}

    ${NSD_CreateLabel} 0 0 0 0 ""
    Pop $4
    !insertmacro InstallerPlace $4 0 0 504 48
    ${NSD_AddStyle} $4 ${SS_NOTIFY}
    ${NSD_OnClick} $4 InstallerDrag
    !insertmacro InstallerControlColors $4
    ${NSD_CreateButton} 0 0 0 0 "−"
    Pop $4
    !insertmacro InstallerPlace $4 504 8 40 32
    ${NSD_OnClick} $4 InstallerMinimize
    ${NSD_OnNotify} $4 InstallerPaintButton
    ${NSD_CreateButton} 0 0 0 0 "×"
    Pop $4
    !insertmacro InstallerPlace $4 548 8 40 32
    ${NSD_OnClick} $4 InstallerClose
    ${NSD_OnNotify} $4 InstallerPaintButton

    ${NSD_CreateBitmap} 0 0 0 0 ""
    Pop $4
    !insertmacro InstallerPlace $4 0 $InstallerBrandY ${INSTALLER_WINDOW_SIZE} ${INSTALLER_BRAND_HEIGHT}
    StrCpy $5 "brand"
    ${If} $InstallerTheme == "dark"
        StrCpy $5 "brand-dark"
    ${EndIf}
    ${If} $InstallerDpi <= 96
        ${NSD_SetStretchedImage} $4 "$PLUGINSDIR\$5.bmp" $InstallerImage
    ${Else}
        ${NSD_SetStretchedImage} $4 "$PLUGINSDIR\$5-2x.bmp" $InstallerImage
    ${EndIf}

    ${NSD_CreateLabel} 0 0 0 0 "$(INSTALLER_COPYRIGHT)"
    Pop $4
    !insertmacro InstallerPlace $4 ${INSTALLER_COPYRIGHT_X} ${INSTALLER_COPYRIGHT_Y} ${INSTALLER_COPYRIGHT_WIDTH} ${INSTALLER_COPYRIGHT_HEIGHT}
    ${NSD_AddStyle} $4 ${SS_CENTER}|${SS_CENTERIMAGE}
    SendMessage $4 ${WM_SETFONT} $InstallerSmallFont 1
    !insertmacro InstallerCaptionColors $4 transparent transparent
FunctionEnd

Function InstallerDestroyShell
    ${NSD_FreeImage} $InstallerImage
    System::Call 'gdiplus::GdiplusShutdown(p $InstallerGdiToken)'
    System::Call 'gdi32::DeleteObject(p $InstallerFont)'
    System::Call 'gdi32::DeleteObject(p $InstallerSmallFont)'
    System::Call 'gdi32::DeleteObject(p $InstallerTitleFont)'
FunctionEnd

; The first page shown raises the prepared window once, after its branded controls exist.
Function InstallerPresent
    ShowWindow $InstallerDialog 5
    ShowWindow $HWNDPARENT 5
    ${If} $InstallerPresented == 1
        Return
    ${EndIf}
    StrCpy $InstallerPresented 1
    System::Call '$PLUGINSDIR\window-frame.dll::InstallerPresentWelcome(p $HWNDPARENT) i.r0 ?c'
FunctionEnd

; The introduction steps precede the installation page on a new installation.
Function InstallerGuide
    ${If} ${isUpdated}
        Abort
    ${EndIf}
    StrCpy $InstallerPhase "guide"
    StrCpy $InstallerGuideStep 1
    StrCpy $InstallerBrandY ${INSTALLER_GUIDE_BRAND_Y}
    Call InstallerCreateShell

    ${NSD_CreateLabel} 0 0 0 0 ""
    Pop $InstallerGuideCaption
    !insertmacro InstallerPlace $InstallerGuideCaption ${INSTALLER_GUIDE_TEXT_X} ${INSTALLER_GUIDE_CAPTION_Y} ${INSTALLER_GUIDE_TEXT_WIDTH} ${INSTALLER_GUIDE_CAPTION_HEIGHT}
    ${NSD_AddStyle} $InstallerGuideCaption ${SS_CENTER}|${SS_CENTERIMAGE}
    SendMessage $InstallerGuideCaption ${WM_SETFONT} $InstallerSmallFont 1
    !insertmacro InstallerCaptionColors $InstallerGuideCaption ${INSTALLER_BACKGROUND_LIGHT} ${INSTALLER_BACKGROUND_DARK}

    ${NSD_CreateLabel} 0 0 0 0 ""
    Pop $InstallerGuideTitle
    !insertmacro InstallerPlace $InstallerGuideTitle ${INSTALLER_GUIDE_TEXT_X} ${INSTALLER_GUIDE_TITLE_Y} ${INSTALLER_GUIDE_TEXT_WIDTH} ${INSTALLER_GUIDE_TITLE_HEIGHT}
    ${NSD_AddStyle} $InstallerGuideTitle ${SS_CENTER}|${SS_CENTERIMAGE}
    SendMessage $InstallerGuideTitle ${WM_SETFONT} $InstallerTitleFont 1
    !insertmacro InstallerControlColors $InstallerGuideTitle

    !insertmacro InstallerGuideLine $InstallerGuideLine1 0
    !insertmacro InstallerGuideLine $InstallerGuideLine2 1
    !insertmacro InstallerGuideLine $InstallerGuideLine3 2

    ${NSD_CreateButton} 0 0 0 0 "$(INSTALLER_GUIDE_BACK)"
    Pop $InstallerGuideBack
    !insertmacro InstallerPlace $InstallerGuideBack ${INSTALLER_GUIDE_BACK_X} ${INSTALLER_GUIDE_BUTTON_Y} ${INSTALLER_GUIDE_BUTTON_WIDTH} ${INSTALLER_GUIDE_BUTTON_HEIGHT}
    SendMessage $InstallerGuideBack ${WM_SETFONT} $InstallerFont 1
    ${NSD_OnClick} $InstallerGuideBack InstallerGuideBackClick
    ${NSD_OnNotify} $InstallerGuideBack InstallerPaintButton

    ${NSD_CreateButton} 0 0 0 0 "$(INSTALLER_GUIDE_NEXT)"
    Pop $InstallerGuideNext
    !insertmacro InstallerPlace $InstallerGuideNext ${INSTALLER_GUIDE_NEXT_X} ${INSTALLER_GUIDE_BUTTON_Y} ${INSTALLER_GUIDE_BUTTON_WIDTH} ${INSTALLER_GUIDE_BUTTON_HEIGHT}
    SendMessage $InstallerGuideNext ${WM_SETFONT} $InstallerFont 1
    ${NSD_OnClick} $InstallerGuideNext InstallerGuideNextClick
    ${NSD_OnNotify} $InstallerGuideNext InstallerPaintButton

    Call InstallerRenderGuide
    System::Call 'user32::SetPropW(p $HWNDPARENT, w "HarnessInstaller.Ready", p 1)'
    Call InstallerPresent
    nsDialogs::Show
    ; The page's controls are gone; a recycled handle must not repaint as a guide action.
    StrCpy $InstallerGuideBack 0
    StrCpy $InstallerGuideNext 0
    Call InstallerDestroyShell
FunctionEnd

; The first step centres one action; later steps pair Back with Next.
Function InstallerRenderGuide
    ${NSD_SetText} $InstallerGuideCaption "$InstallerGuideStep / ${INSTALLER_GUIDE_STEPS}"
    !insertmacro InstallerGuideText $InstallerGuideTitle "$(INSTALLER_GUIDE1_TITLE)" "$(INSTALLER_GUIDE2_TITLE)" "$(INSTALLER_GUIDE3_TITLE)"
    !insertmacro InstallerGuideText $InstallerGuideLine1 "$(INSTALLER_GUIDE1_LINE1)" "$(INSTALLER_GUIDE2_LINE1)" "$(INSTALLER_GUIDE3_LINE1)"
    !insertmacro InstallerGuideText $InstallerGuideLine2 "$(INSTALLER_GUIDE1_LINE2)" "$(INSTALLER_GUIDE2_LINE2)" "$(INSTALLER_GUIDE3_LINE2)"
    !insertmacro InstallerGuideText $InstallerGuideLine3 "$(INSTALLER_GUIDE1_LINE3)" "$(INSTALLER_GUIDE2_LINE3)" "$(INSTALLER_GUIDE3_LINE3)"
    ${If} $InstallerGuideStep == 1
        ShowWindow $InstallerGuideBack 0
        !insertmacro InstallerPlace $InstallerGuideNext ${INSTALLER_BUTTON_X} ${INSTALLER_BUTTON_Y} ${INSTALLER_BUTTON_WIDTH} ${INSTALLER_BUTTON_HEIGHT}
    ${Else}
        ShowWindow $InstallerGuideBack 5
        !insertmacro InstallerPlace $InstallerGuideBack ${INSTALLER_GUIDE_BACK_X} ${INSTALLER_GUIDE_BUTTON_Y} ${INSTALLER_GUIDE_BUTTON_WIDTH} ${INSTALLER_GUIDE_BUTTON_HEIGHT}
        !insertmacro InstallerPlace $InstallerGuideNext ${INSTALLER_GUIDE_NEXT_X} ${INSTALLER_GUIDE_BUTTON_Y} ${INSTALLER_GUIDE_BUTTON_WIDTH} ${INSTALLER_GUIDE_BUTTON_HEIGHT}
    ${EndIf}
FunctionEnd

Function InstallerGuideBackClick
    Pop $0
    ${If} $InstallerGuideStep == 1
        Return
    ${EndIf}
    IntOp $InstallerGuideStep $InstallerGuideStep - 1
    Call InstallerRenderGuide
FunctionEnd

Function InstallerGuideNextClick
    Pop $0
    ${If} $InstallerGuideStep < ${INSTALLER_GUIDE_STEPS}
        IntOp $InstallerGuideStep $InstallerGuideStep + 1
        Call InstallerRenderGuide
        Return
    ${EndIf}
    SendMessage $HWNDPARENT ${WM_NOTIFY_OUTER_NEXT} 1 0
FunctionEnd

Function InstallerCreate
    StrCpy $InstallerBrandY ${INSTALLER_BRAND_Y}
    Call InstallerCreateShell

    ${NSD_CreateLabel} 0 0 0 0 ""
    Pop $InstallerStatus
    !insertmacro InstallerPlace $InstallerStatus 48 ${INSTALLER_STATUS_Y} 504 ${INSTALLER_STATUS_HEIGHT}
    ${NSD_AddStyle} $InstallerStatus ${SS_CENTER}|${SS_CENTERIMAGE}
    SendMessage $InstallerStatus ${WM_SETFONT} $InstallerSmallFont 1
    !insertmacro InstallerControlColors $InstallerStatus

    ${NSD_CreateButton} 0 0 0 0 "$(INSTALLER_CHOOSE_PATH)"
    Pop $InstallerChoose
    !insertmacro InstallerPlace $InstallerChoose 232 438 136 28
    ${NSD_OnClick} $InstallerChoose InstallerExpandPath
    ${NSD_OnNotify} $InstallerChoose InstallerPaintButton
    ${NSD_CreateBitmap} 0 0 0 0 ""
    Pop $InstallerEditFrame
    !insertmacro InstallerPlace $InstallerEditFrame 64 434 384 34
    Call InstallerDrawEditFrame
    ${NSD_CreateText} 0 0 0 0 "$InstallerPath"
    Pop $InstallerEdit
    System::Call 'user32::GetWindowLongW(p $InstallerEdit, i -16) i.r0'
    IntOp $0 $0 & 0xFF7FFFFF
    System::Call 'user32::SetWindowLongW(p $InstallerEdit, i -16, i r0)'
    System::Call 'user32::GetWindowLongW(p $InstallerEdit, i -20) i.r0'
    IntOp $0 $0 & 0xFFFFFDFF
    System::Call 'user32::SetWindowLongW(p $InstallerEdit, i -20, i r0)'
    SendMessage $InstallerEdit ${WM_SETFONT} $InstallerSmallFont 1
    ; A borderless single-line edit sits inside a separate padded frame.
    System::Call 'user32::GetDC(p $InstallerEdit) p.r4'
    System::Call 'gdi32::SelectObject(p r4, p $InstallerSmallFont) p.r5'
    System::Alloc 60
    Pop $6
    System::Call 'gdi32::GetTextMetricsW(p r4, p r6)'
    System::Call '*$6(i .r7)'
    System::Free $6
    System::Call 'gdi32::SelectObject(p r4, p r5)'
    System::Call 'user32::ReleaseDC(p $InstallerEdit, p r4)'
    System::Call 'kernel32::MulDiv(i 76, i $InstallerDpi, i 96) i.r0'
    System::Call 'kernel32::MulDiv(i 434, i $InstallerDpi, i 96) i.r1'
    System::Call 'kernel32::MulDiv(i 360, i $InstallerDpi, i 96) i.r2'
    System::Call 'kernel32::MulDiv(i 34, i $InstallerDpi, i 96) i.r3'
    IntOp $3 $3 - $7
    IntOp $3 $3 / 2
    IntOp $1 $1 + $3
    System::Call 'user32::MoveWindow(p $InstallerEdit, i r0, i r1, i r2, i r7, i 1)'
    System::Call 'user32::SetWindowPos(p $InstallerEdit, p 0, i 0, i 0, i 0, i 0, i 0x33)'
    SendMessage $InstallerEdit ${EM_SETLIMITTEXT} 180 0
    !insertmacro InstallerControlColors $InstallerEdit
    ${NSD_OnChange} $InstallerEdit InstallerPathChanged
    ${NSD_CreateButton} 0 0 0 0 "$(INSTALLER_BROWSE)"
    Pop $InstallerBrowse
    !insertmacro InstallerPlace $InstallerBrowse 456 434 80 34
    ${NSD_OnClick} $InstallerBrowse InstallerBrowsePath
    ${NSD_OnNotify} $InstallerBrowse InstallerPaintButton
    ${NSD_CreateCheckbox} 0 0 0 0 "$(INSTALLER_LAUNCH)"
    Pop $InstallerLaunch
    SendMessage $InstallerLaunch ${WM_SETFONT} $InstallerSmallFont 1
    System::Call 'user32::GetDC(p $InstallerLaunch) p.r4'
    System::Call 'gdi32::SelectObject(p r4, p $InstallerSmallFont) p.r5'
    StrLen $0 "$(INSTALLER_LAUNCH)"
    System::Alloc 8
    Pop $6
    System::Call 'gdi32::GetTextExtentPoint32W(p r4, w "$(INSTALLER_LAUNCH)", i r0, p r6)'
    System::Call '*$6(i .r7)'
    System::Free $6
    System::Call 'gdi32::SelectObject(p r4, p r5)'
    System::Call 'user32::ReleaseDC(p $InstallerLaunch, p r4)'
    System::Call 'kernel32::MulDiv(i 42, i $InstallerDpi, i 96) i.r2'
    IntOp $2 $2 + $7
    IntOp $0 $InstallerSize - $2
    IntOp $0 $0 / 2
    System::Call 'kernel32::MulDiv(i 438, i $InstallerDpi, i 96) i.r1'
    System::Call 'kernel32::MulDiv(i 32, i $InstallerDpi, i 96) i.r3'
    System::Call 'user32::MoveWindow(p $InstallerLaunch, i r0, i r1, i r2, i r3, i 1)'
    !insertmacro InstallerControlColors $InstallerLaunch
    ${NSD_OnNotify} $InstallerLaunch InstallerPaintCheckbox
    ${NSD_Check} $InstallerLaunch

    ${NSD_CreateButton} 0 0 0 0 "$(INSTALLER_INSTALL)"
    Pop $InstallerButton
    !insertmacro InstallerPlace $InstallerButton ${INSTALLER_BUTTON_X} ${INSTALLER_BUTTON_Y} ${INSTALLER_BUTTON_WIDTH} ${INSTALLER_BUTTON_HEIGHT}
    SendMessage $InstallerButton ${WM_SETFONT} $InstallerFont 1
    ${NSD_OnClick} $InstallerButton InstallerStart
    ${NSD_OnNotify} $InstallerButton InstallerPaintButton
    Call InstallerRender
    System::Call 'user32::SetPropW(p $HWNDPARENT, w "HarnessInstaller.Ready", p 1)'
    Call InstallerPresent
    nsDialogs::Show
    ${NSD_KillTimer} InstallerValidateEditedPath
    ${NSD_FreeImage} $InstallerEditFrameBitmap
    Call InstallerDestroyShell
FunctionEnd

Function InstallerRender
    ShowWindow $InstallerChoose 0
    ShowWindow $InstallerEdit 0
    ShowWindow $InstallerEditFrame 0
    ShowWindow $InstallerBrowse 0
    ShowWindow $InstallerLaunch 0
    ShowWindow $InstallerStatus 0
    ${If} $InstallerPhase == "success"
        ${NSD_SetText} $InstallerButton "$(INSTALLER_FINISH)"
        ShowWindow $InstallerLaunch 5
    ${Else}
        ${NSD_SetText} $InstallerButton "$(INSTALLER_INSTALL)"
        ${If} $InstallerExpanded == 1
            ShowWindow $InstallerEditFrame 5
            ShowWindow $InstallerEdit 5
            ShowWindow $InstallerBrowse 5
        ${Else}
            ShowWindow $InstallerChoose 5
        ${EndIf}
    ${EndIf}
FunctionEnd

Function InstallerStart
    Pop $0
    SendMessage $HWNDPARENT ${WM_NOTIFY_OUTER_NEXT} 1 0
FunctionEnd

; Page leave callbacks also run when Enter activates NSIS's hidden default button.
Function InstallerWelcomeLeave
    ${NSD_GetText} $InstallerEdit $InstallerPath
    Call InstallerPreflight
    ${If} $InstallerError != ""
        MessageBox MB_OK|MB_ICONEXCLAMATION "$InstallerError"
        Abort
    ${EndIf}
FunctionEnd

Function InstallerFinishLeave
    ${NSD_GetState} $InstallerLaunch $0
    HideWindow
    ${If} $0 == ${BST_CHECKED}
        StrCpy $0 ""
        ${If} ${isUpdated}
            StrCpy $0 "--updated"
        ${EndIf}
        ClearErrors
        ${If} ${UAC_IsAdmin}
            ; An explicitly elevated installer must still launch through the user's shell.
            ${StdUtils.ExecShellAsUser} $1 "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "open" "$0"
            ${If} $1 != "ok"
            ${AndIf} $1 != "fallback"
                SetErrors
            ${EndIf}
        ${Else}
            ; Per-user installation can create the process without Explorer/shortcut dispatch.
            Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" $0'
        ${EndIf}
        ${If} ${Errors}
            ShowWindow $HWNDPARENT 5
            MessageBox MB_OK|MB_ICONEXCLAMATION "$(INSTALLER_LAUNCH_FAILED)"
            Abort
        ${EndIf}
    ${EndIf}
FunctionEnd

Function InstallerExpandPath
    Pop $0
    StrCpy $InstallerExpanded 1
    Call InstallerRender
    SendMessage $InstallerEdit ${EM_SETSEL} 0 0
    System::Call 'user32::SetFocus(p $InstallerEdit)'
FunctionEnd

Function InstallerPathChanged
    Pop $0
    ${NSD_CreateTimer} InstallerValidateEditedPath 450
FunctionEnd

Function InstallerValidateEditedPath
    ${NSD_KillTimer} InstallerValidateEditedPath
    ${If} $InstallerPhase != "welcome"
        Return
    ${EndIf}
    ${NSD_GetText} $InstallerEdit $InstallerPath
    Call InstallerValidatePath
    ${NSD_SetText} $InstallerStatus "$InstallerError"
    !insertmacro InstallerPlace $InstallerStatus 48 538 504 38
    ShowWindow $InstallerStatus 5
FunctionEnd

Function InstallerBrowsePath
    Pop $0
    nsDialogs::SelectFolderDialog "$(INSTALLER_CHOOSE_PATH)" "$InstallerPath"
    Pop $0
    ${If} $0 != "error"
        ${NSD_SetText} $InstallerEdit "$0"
        Call InstallerValidateEditedPath
    ${EndIf}
FunctionEnd

Function InstallerDrag
    Pop $0
    System::Call 'user32::ReleaseCapture()'
    SendMessage $HWNDPARENT ${WM_NCLBUTTONDOWN} 2 0
FunctionEnd

; NM_CUSTOMDRAW keeps native button focus, keyboard input and accessible text.
; This NMCUSTOMDRAW layout is for the x86 NSIS stub, including on x64 Windows.
Function InstallerPaintButton
    Pop $R0
    Pop $R1
    Pop $R2
    ${If} $R1 != -12
        Return
    ${EndIf}
    System::Call '*$R2(p, p, i, i .R3, p .R4, i .R5, i .R6, i .R7, i .R8, p, i .R9)'
    ${If} $R3 != 1
        Return
    ${EndIf}
    System::Call 'gdi32::SaveDC(p R4)'
    System::Alloc 16
    Pop $R2
    System::Call 'user32::GetClientRect(p R0, p R2)'
    System::Call 'gdi32::CreateSolidBrush(i $InstallerBgColorref) p.R3'
    System::Call 'user32::FillRect(p R4, p R2, p R3)'
    System::Call 'gdi32::DeleteObject(p R3)'
    StrCpy $R3 $InstallerBgArgb
    ${If} $R0 == $InstallerButton
    ${OrIf} $R0 == $InstallerGuideNext
        StrCpy $R3 $InstallerPrimary
        IntOp $R1 $R9 & 64
        ${If} $R1 != 0
            StrCpy $R3 $InstallerPrimaryHover
        ${EndIf}
        IntOp $R1 $R9 & 1
        ${If} $R1 != 0
            StrCpy $R3 $InstallerPrimaryPressed
        ${EndIf}
    ${Else}
        IntOp $R1 $R9 & 65
        ${If} $R1 != 0
            StrCpy $R3 $InstallerControlHover
        ${EndIf}
    ${EndIf}
    System::Call 'gdiplus::GdipCreateSolidFill(i R3, *p .R1)'
    System::Call 'gdiplus::GdipCreateFromHDC(p R4, *p .R5)'
    System::Call 'gdiplus::GdipSetSmoothingMode(p R5, i 4)'
    System::Call 'gdiplus::GdipSetPixelOffsetMode(p R5, i 4)'
    System::Call 'kernel32::MulDiv(i ${INSTALLER_BUTTON_DIAMETER}, i $InstallerDpi, i 96) i.R3'
    ${If} $R0 == $InstallerBrowse
    ${OrIf} $R0 == $InstallerGuideBack
        System::Call 'kernel32::MulDiv(i 12, i $InstallerDpi, i 96) i.R3'
    ${EndIf}
    !insertmacro InstallerRoundPath $R6 $R7 $R8 $R3
    System::Call 'gdiplus::GdipFillPath(p R5, p R1, p R6)'
    ${If} $R0 == $InstallerBrowse
    ${OrIf} $R0 == $InstallerGuideBack
        System::Call 'gdiplus::GdipCreatePen1(i $InstallerBorder, i 0x40000000, i 2, *p .r2)'
        System::Call 'gdiplus::GdipDrawPath(p R5, p r2, p R6)'
        System::Call 'gdiplus::GdipDeletePen(p r2)'
    ${EndIf}
    System::Call 'gdiplus::GdipDeletePath(p R6)'
    System::Call 'gdiplus::GdipDeleteGraphics(p R5)'
    System::Call 'gdiplus::GdipDeleteBrush(p R1)'
    System::Call 'gdi32::SetBkMode(p R4, i 1)'
    ${If} $R0 == $InstallerButton
    ${OrIf} $R0 == $InstallerGuideNext
        System::Call 'gdi32::SetTextColor(p R4, i $InstallerButtonText)'
    ${Else}
        System::Call 'gdi32::SetTextColor(p R4, i $InstallerTextColorref)'
    ${EndIf}
    System::Call 'gdi32::SelectObject(p R4, p $InstallerFont)'
    ${If} $R0 == $InstallerChoose
    ${OrIf} $R0 == $InstallerBrowse
        System::Call 'gdi32::SelectObject(p R4, p $InstallerSmallFont)'
    ${EndIf}
    ${NSD_GetText} $R0 $R3
    System::Call 'user32::DrawTextW(p R4, w R3, i -1, p R2, i 0x25)'
    IntOp $R9 $R9 & 16
    ${If} $R9 != 0
        System::Call 'user32::InflateRect(p R2, i -4, i -4)'
        System::Call 'user32::DrawFocusRect(p R4, p R2)'
    ${EndIf}
    System::Call 'gdi32::RestoreDC(p R4, i -1)'
    System::Free $R2
    ${NSD_Return} 4
FunctionEnd

Function InstallerMinimize
    Pop $0
    ShowWindow $HWNDPARENT 6
FunctionEnd

Function InstallerClose
    Pop $0
    System::Call 'user32::PostMessageW(p $HWNDPARENT, i ${WM_CLOSE}, p 0, p 0)'
FunctionEnd
!endif
