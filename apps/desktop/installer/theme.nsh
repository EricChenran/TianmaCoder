; Figma logical pixels, independent of the Windows display scale.
!define INSTALLER_WINDOW_SIZE 600
!define INSTALLER_BRAND_Y 174
!define INSTALLER_BRAND_HEIGHT 196
; The copyright caption closes the page above the bottom edge.
!define INSTALLER_COPYRIGHT_X 48
!define INSTALLER_COPYRIGHT_Y 578
!define INSTALLER_COPYRIGHT_WIDTH 504
!define INSTALLER_COPYRIGHT_HEIGHT 16
!define INSTALLER_BUTTON_X 240
!define INSTALLER_BUTTON_Y 490
!define INSTALLER_BUTTON_WIDTH 120
!define INSTALLER_BUTTON_HEIGHT 44
!define INSTALLER_BUTTON_DIAMETER 20
!define INSTALLER_PROGRESS_X 64
!define INSTALLER_PROGRESS_Y 482
!define INSTALLER_PROGRESS_WIDTH 472
!define INSTALLER_PROGRESS_HEIGHT 6
!define INSTALLER_PROGRESS_DIAMETER 4
!define INSTALLER_STATUS_Y 512
!define INSTALLER_STATUS_HEIGHT 22
!define INSTALLER_FONT "Microsoft YaHei UI"
!define INSTALLER_BUTTON_FONT_SIZE 16
!define INSTALLER_STATUS_FONT_SIZE 14
; The introduction steps replace the action controls with a text block above the same button row.
!define INSTALLER_GUIDE_STEPS 3
!define INSTALLER_GUIDE_BRAND_Y 48
!define INSTALLER_GUIDE_TEXT_X 48
!define INSTALLER_GUIDE_TEXT_WIDTH 504
!define INSTALLER_GUIDE_CAPTION_Y 256
!define INSTALLER_GUIDE_CAPTION_HEIGHT 20
!define INSTALLER_GUIDE_TITLE_Y 288
!define INSTALLER_GUIDE_TITLE_HEIGHT 32
!define INSTALLER_GUIDE_TITLE_FONT_SIZE 20
!define INSTALLER_GUIDE_BODY_Y 352
!define INSTALLER_GUIDE_BODY_HEIGHT 22
!define INSTALLER_GUIDE_BODY_GAP 30
!define INSTALLER_GUIDE_BACK_X 168
!define INSTALLER_GUIDE_NEXT_X 312
!define INSTALLER_GUIDE_BUTTON_Y 490
!define INSTALLER_GUIDE_BUTTON_WIDTH 120
!define INSTALLER_GUIDE_BUTTON_HEIGHT 44
; SetCtlColors takes compile-time colors only; these are the two page backgrounds.
!define INSTALLER_BACKGROUND_LIGHT FFFFFF
!define INSTALLER_BACKGROUND_DARK 151517
; GDI+ ARGB values; GDI text uses COLORREF below.
!define INSTALLER_PRIMARY 0xFF0F1115
!define INSTALLER_PRIMARY_HOVER 0xFF2D3135
!define INSTALLER_PRIMARY_PRESSED 0xFF000000
!define INSTALLER_CONTROL_HOVER 0xFFEEF0F2
!define INSTALLER_TRACK_COLOR 0xFFE9ECF2
!define INSTALLER_TEXT_COLORREF 0x15110F

Var InstallerTheme
Var InstallerBgHex
Var InstallerTextHex
Var InstallerBgArgb
Var InstallerBgColorref
Var InstallerTextColorref
Var InstallerPrimary
Var InstallerPrimaryHover
Var InstallerPrimaryPressed
Var InstallerControlHover
Var InstallerTrack
Var InstallerButtonText
Var InstallerBorder

; SetCtlColors accepts only compile-time colors; choose between the two native palettes.
!macro InstallerControlColors HANDLE
    ${If} $InstallerTheme == "dark"
        SetCtlColors ${HANDLE} FFFFFF ${INSTALLER_BACKGROUND_DARK}
    ${Else}
        SetCtlColors ${HANDLE} 0F1115 ${INSTALLER_BACKGROUND_LIGHT}
    ${EndIf}
!macroend

; A muted caption keeps the page's two-tone palette. A transparent background lets the
; dialog behind it show through for text that never changes; text the page rewrites
; passes its background so the previous wording cannot leave glyphs in the label.
!macro InstallerCaptionColors HANDLE LIGHT_BACKGROUND DARK_BACKGROUND
    ${If} $InstallerTheme == "dark"
        SetCtlColors ${HANDLE} A0A4AB ${DARK_BACKGROUND}
    ${Else}
        SetCtlColors ${HANDLE} 8A9099 ${LIGHT_BACKGROUND}
    ${EndIf}
!macroend

Function InstallerResolveTheme
    ${If} $InstallerTheme == "auto"
        ClearErrors
        ReadRegDWORD $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Themes\Personalize" "AppsUseLightTheme"
        ${If} ${Errors}
            StrCpy $0 1
        ${EndIf}
        ${If} $0 == 0
            StrCpy $InstallerTheme "dark"
        ${Else}
            StrCpy $InstallerTheme "light"
        ${EndIf}
    ${EndIf}
    ${If} $InstallerTheme == "dark"
        StrCpy $InstallerBgHex "151517"
        StrCpy $InstallerTextHex "FFFFFF"
        StrCpy $InstallerBgArgb 0xFF151517
        StrCpy $InstallerBgColorref 0x171515
        StrCpy $InstallerTextColorref 0xFFFFFF
        StrCpy $InstallerPrimary 0xFFF9FAFB
        StrCpy $InstallerPrimaryHover 0xFFE9ECF2
        StrCpy $InstallerPrimaryPressed 0xFFD4DBE9
        StrCpy $InstallerControlHover 0xFF303034
        StrCpy $InstallerTrack 0xFF61666B
        StrCpy $InstallerButtonText 0x15110F
        StrCpy $InstallerBorder 0xFF61666B
    ${Else}
        StrCpy $InstallerBgHex "FFFFFF"
        StrCpy $InstallerTextHex "0F1115"
        StrCpy $InstallerBgArgb 0xFFFFFFFF
        StrCpy $InstallerBgColorref 0xFFFFFF
        StrCpy $InstallerTextColorref ${INSTALLER_TEXT_COLORREF}
        StrCpy $InstallerPrimary ${INSTALLER_PRIMARY}
        StrCpy $InstallerPrimaryHover ${INSTALLER_PRIMARY_HOVER}
        StrCpy $InstallerPrimaryPressed ${INSTALLER_PRIMARY_PRESSED}
        StrCpy $InstallerControlHover ${INSTALLER_CONTROL_HOVER}
        StrCpy $InstallerTrack ${INSTALLER_TRACK_COLOR}
        StrCpy $InstallerButtonText 0xFFFFFF
        StrCpy $InstallerBorder 0xFFBBC0C8
    ${EndIf}
FunctionEnd
