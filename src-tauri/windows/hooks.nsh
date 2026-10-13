!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe" "" "Sheetlight"
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe" "FriendlyAppName" "Sheetlight"
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\DefaultIcon" "" "$INSTDIR\${MAINBINARYNAME}.exe,0"
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes" ".xlsx" ""
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes" ".xls" ""
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes" ".csv" ""

  WriteRegStr SHCTX "Software\Classes\.xlsx\OpenWithProgids" "Sheetlight.Xlsx" ""
  WriteRegStr SHCTX "Software\Classes\.xls\OpenWithProgids" "Sheetlight.Xls" ""
  WriteRegStr SHCTX "Software\Classes\.csv\OpenWithProgids" "Sheetlight.Csv" ""

  WriteRegStr SHCTX "Software\Classes\.xlsx\OpenWithList\${MAINBINARYNAME}.exe" "" ""
  WriteRegStr SHCTX "Software\Classes\.xls\OpenWithList\${MAINBINARYNAME}.exe" "" ""
  WriteRegStr SHCTX "Software\Classes\.csv\OpenWithList\${MAINBINARYNAME}.exe" "" ""

  WriteRegStr SHCTX "Software\Sheetlight\Capabilities" "ApplicationName" "Sheetlight"
  WriteRegStr SHCTX "Software\Sheetlight\Capabilities" "ApplicationDescription" "A lightweight, fast local spreadsheet app"
  WriteRegStr SHCTX "Software\Sheetlight\Capabilities" "ApplicationIcon" "$INSTDIR\${MAINBINARYNAME}.exe,0"
  WriteRegStr SHCTX "Software\Sheetlight\Capabilities\FileAssociations" ".xlsx" "Sheetlight.Xlsx"
  WriteRegStr SHCTX "Software\Sheetlight\Capabilities\FileAssociations" ".xls" "Sheetlight.Xls"
  WriteRegStr SHCTX "Software\Sheetlight\Capabilities\FileAssociations" ".csv" "Sheetlight.Csv"
  WriteRegStr SHCTX "Software\RegisteredApplications" "Sheetlight" "Software\Sheetlight\Capabilities"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe"
  DeleteRegValue SHCTX "Software\Classes\.xlsx\OpenWithProgids" "Sheetlight.Xlsx"
  DeleteRegValue SHCTX "Software\Classes\.xls\OpenWithProgids" "Sheetlight.Xls"
  DeleteRegValue SHCTX "Software\Classes\.csv\OpenWithProgids" "Sheetlight.Csv"
  DeleteRegKey SHCTX "Software\Classes\.xlsx\OpenWithList\${MAINBINARYNAME}.exe"
  DeleteRegKey SHCTX "Software\Classes\.xls\OpenWithList\${MAINBINARYNAME}.exe"
  DeleteRegKey SHCTX "Software\Classes\.csv\OpenWithList\${MAINBINARYNAME}.exe"
  DeleteRegKey SHCTX "Software\Sheetlight"
  DeleteRegValue SHCTX "Software\RegisteredApplications" "Sheetlight"
!macroend
