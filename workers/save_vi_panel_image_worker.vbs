Option Explicit

' ===========================================================================
' save_vi_panel_image_worker.vbs
' ===========================================================================
' 使用 LabVIEW ActiveX/COM 的 GetPanelImage 导出前面板 PNG，
' 使用 PrintVIToHTML 导出程序框图 PNG。
'
' 命名参数
'   /viPath             VI 文件完整路径（必填）
'   /panel              fp | bd（兼容旧调用；与 /outputPath 配对使用）
'   /outputPath         输出 PNG 路径（兼容旧调用）
'   /fpOutputPath       前面板 PNG 输出路径（可选）
'   /bdOutputPath       程序框图 PNG 输出路径（可选）
'   /responsePath       响应文件路径（必填）
'   /timeoutSeconds     连接超时秒数（默认 45）
'   /targetExe          目标 LabVIEW.exe 路径（可选）
'   /expectedDirectory  预期的 ApplicationDirectory（可选）
'   /expectedVersion    预期的 Version 前缀，例如 "17.0"（可选）
'
' 响应文件格式（ASCII 编码）
'   ok=1|0
'   selection=<ascii>
'   reason_b64=<Base64-UTF8>
'   connected_version_b64=<Base64-UTF8>
'   connected_directory_b64=<Base64-UTF8>
'   attempts=<整数>
'   output_path_b64=<Base64-UTF8>      (兼容旧调用；优先写 fp，其次写 bd)
'   fp_output_path_b64=<Base64-UTF8>
'   bd_output_path_b64=<Base64-UTF8>
' ===========================================================================

Const PRINT_FORMAT_COMPLETE = 4
Const HTML_IMAGE_FORMAT_PNG = 0
Const FP_STATE_VISIBLE = 1
Const FP_STATE_HIDDEN = 3
Const WIA_FORMAT_PNG = "{B96B3CAF-0728-11D3-9D7B-0000F81EF32E}"
Const BMP_INFO_HEADER_SIZE = 40
Const BMP_PIXEL_DATA_OFFSET = 54
Const BMP_PIXELS_PER_METER = 2835

Dim viPath
Dim panel
Dim outputPath
Dim fpOutputPath
Dim bdOutputPath
Dim targetExe
Dim expectedDirectory
Dim expectedVersion
Dim responsePath
Dim timeoutSeconds
Dim retryIntervalMs

viPath            = GetNamedArg("viPath", "")
panel             = LCase(GetNamedArg("panel", "fp"))
outputPath        = GetNamedArg("outputPath", "")
fpOutputPath      = GetNamedArg("fpOutputPath", "")
bdOutputPath      = GetNamedArg("bdOutputPath", "")
targetExe         = GetNamedArg("targetExe", "")
expectedDirectory = GetNamedArg("expectedDirectory", "")
expectedVersion   = GetNamedArg("expectedVersion", "")
responsePath      = GetNamedArg("responsePath", "")
timeoutSeconds    = CLng(GetNamedArg("timeoutSeconds", "45"))
retryIntervalMs   = 750

Dim app
Dim vi
Dim attempts
Dim selection
Dim reason
Dim connectedVersion
Dim connectedDirectory
Dim exportedOutputPath
Dim exportedFpOutputPath
Dim exportedBdOutputPath

Set app              = Nothing
Set vi               = Nothing
attempts             = 0
selection            = ""
reason               = ""
connectedVersion     = ""
connectedDirectory   = ""
exportedOutputPath   = ""
exportedFpOutputPath = ""
exportedBdOutputPath = ""

On Error Resume Next
Main
If Err.Number <> 0 Then
    reason = Err.Description
    WriteResponse False
    WScript.Quit 3
End If
On Error GoTo 0

Sub Main()
    If Len(responsePath) = 0 Then
        Err.Raise vbObjectError + 100, , "Missing responsePath argument."
    End If
    If Len(viPath) = 0 Then
        Err.Raise vbObjectError + 101, , "Missing viPath argument."
    End If
    If Not FileExists(viPath) Then
        Err.Raise vbObjectError + 103, , "VI file not found: " & viPath
    End If

    If Len(outputPath) > 0 Then
        If panel <> "fp" And panel <> "bd" Then
            Err.Raise vbObjectError + 104, , "panel must be fp or bd when outputPath is used."
        End If
        If panel = "bd" Then
            bdOutputPath = outputPath
        Else
            fpOutputPath = outputPath
        End If
    ElseIf Len(panel) > 0 And panel <> "fp" And panel <> "bd" Then
        Err.Raise vbObjectError + 104, , "panel must be fp or bd."
    End If

    If Len(fpOutputPath) = 0 And Len(bdOutputPath) = 0 Then
        Err.Raise vbObjectError + 102, , "Missing outputPath/fpOutputPath/bdOutputPath argument."
    End If

    ConnectLabVIEW

    Err.Clear
    Set vi = app.GetVIReference(viPath)
    If Err.Number <> 0 Then
        Err.Raise vbObjectError + 105, , "GetVIReference failed: " & Err.Description
    End If

    ExportPanelImages vi, fpOutputPath, bdOutputPath
    If Len(exportedFpOutputPath) > 0 Then
        exportedOutputPath = exportedFpOutputPath
    Else
        exportedOutputPath = exportedBdOutputPath
    End If
    reason = "Image export succeeded."

    WriteResponse True
    ReleaseComObject vi
    ReleaseComObject app
    WScript.Quit 0
End Sub

Sub ExportPanelImages(ByRef viRef, ByVal fpFinalOutputPath, ByVal bdFinalOutputPath)
    Dim fso
    Dim tempRoot
    Dim exportRoot
    Dim htmlPath
    Dim imageDir
    Dim sourcePath
    Dim htmlExported
    Dim exportError

    Set fso = CreateObject("Scripting.FileSystemObject")
    tempRoot = GetTempFolder()
    exportRoot = BuildUniqueTempDir(tempRoot, "lv-html-export-")
    htmlPath = fso.BuildPath(exportRoot, "export.html")
    imageDir = fso.BuildPath(exportRoot, "images")
    htmlExported = False
    exportError = ""

    If Not fso.FolderExists(exportRoot) Then fso.CreateFolder exportRoot
    If Not fso.FolderExists(imageDir) Then fso.CreateFolder imageDir

    If Len(fpFinalOutputPath) > 0 Then
        If Not TrySaveFrontPanelImage(viRef, fpFinalOutputPath, exportRoot, htmlPath, imageDir, htmlExported, exportError) Then
            CleanupFolder exportRoot
            Err.Raise vbObjectError + 107, , exportError
            Exit Sub
        End If
        exportedFpOutputPath = fpFinalOutputPath
    End If

    If Len(bdFinalOutputPath) > 0 Then
        If Not EnsureHtmlExport(viRef, htmlPath, imageDir, htmlExported, exportError) Then
            CleanupFolder exportRoot
            Err.Raise vbObjectError + 106, , exportError
            Exit Sub
        End If
        sourcePath = FindExportedImage(imageDir, "d.png")
        If Len(sourcePath) = 0 Then
            CleanupFolder exportRoot
            Err.Raise vbObjectError + 108, , "LabVIEW HTML export did not produce *d.png."
            Exit Sub
        End If
        EnsureParentFolder bdFinalOutputPath
        fso.CopyFile sourcePath, bdFinalOutputPath, True
        exportedBdOutputPath = bdFinalOutputPath
    End If

    CleanupFolder exportRoot
End Sub

Function TrySaveFrontPanelImage(ByRef viRef, ByVal finalOutputPath, ByVal exportRoot, ByVal htmlPath, ByVal imageDir, ByRef htmlExported, ByRef errorMessage)
    Dim fso
    Dim sourcePath
    Dim captureError
    Dim fallbackError

    TrySaveFrontPanelImage = False
    errorMessage = ""
    captureError = ""
    fallbackError = ""
    Set fso = CreateObject("Scripting.FileSystemObject")

    If TryCaptureFrontPanelPng(viRef, finalOutputPath, exportRoot, captureError) Then
        TrySaveFrontPanelImage = True
        Exit Function
    End If

    If Not EnsureHtmlExport(viRef, htmlPath, imageDir, htmlExported, fallbackError) Then
        errorMessage = "GetPanelImage failed: " & captureError & ". HTML fallback failed: " & fallbackError
        Exit Function
    End If

    sourcePath = FindExportedImage(imageDir, "p.png")
    If Len(sourcePath) = 0 Then
        errorMessage = "GetPanelImage failed: " & captureError & ". LabVIEW HTML export did not produce *p.png."
        Exit Function
    End If

    On Error Resume Next
    Err.Clear
    EnsureParentFolder finalOutputPath
    fso.CopyFile sourcePath, finalOutputPath, True
    If Err.Number <> 0 Then
        errorMessage = "GetPanelImage failed: " & captureError & ". HTML fallback copy failed: " & Err.Description
        Err.Clear
        On Error GoTo 0
        Exit Function
    End If
    On Error GoTo 0

    TrySaveFrontPanelImage = True
End Function

Function EnsureHtmlExport(ByRef viRef, ByVal htmlPath, ByVal imageDir, ByRef alreadyExported, ByRef errorMessage)
    EnsureHtmlExport = False
    errorMessage = ""

    If alreadyExported Then
        EnsureHtmlExport = True
        Exit Function
    End If

    On Error Resume Next
    Err.Clear
    viRef.PrintVIToHTML htmlPath, False, PRINT_FORMAT_COMPLETE, HTML_IMAGE_FORMAT_PNG, 24, imageDir
    If Err.Number <> 0 Then
        errorMessage = "PrintVIToHTML failed: " & Err.Description
        Err.Clear
        On Error GoTo 0
        Exit Function
    End If
    On Error GoTo 0

    alreadyExported = True
    EnsureHtmlExport = True
End Function

Function TryCaptureFrontPanelPng(ByRef viRef, ByVal outputPath, ByVal exportRoot, ByRef errorMessage)
    Dim imageData
    Dim colors
    Dim bounds
    Dim width
    Dim height
    Dim imageLowerBound
    Dim imageUpperBound
    Dim actualBytes
    Dim expectedBytes
    Dim rawPath

    TryCaptureFrontPanelPng = False
    errorMessage = ""

    If Not TryOpenFrontPanel(viRef, errorMessage) Then
        Exit Function
    End If

    WScript.Sleep 800

    On Error Resume Next
    Err.Clear
    viRef.GetPanelImage True, 24, imageData, colors, bounds
    If Err.Number <> 0 Then
        errorMessage = "GetPanelImage failed: " & Err.Description
        Err.Clear
        On Error GoTo 0
        CloseFrontPanelSafe viRef
        Exit Function
    End If
    On Error GoTo 0

    If Not TryReadPanelBounds(bounds, width, height, errorMessage) Then
        CloseFrontPanelSafe viRef
        Exit Function
    End If

    If Not TryGetArrayBounds(imageData, imageLowerBound, imageUpperBound, errorMessage) Then
        CloseFrontPanelSafe viRef
        Exit Function
    End If

    actualBytes = imageUpperBound - imageLowerBound + 1
    expectedBytes = CLng(width) * CLng(height) * 3
    If actualBytes <> expectedBytes Then
        errorMessage = "GetPanelImage returned " & CStr(actualBytes) & " bytes, expected " & CStr(expectedBytes) & "."
        CloseFrontPanelSafe viRef
        Exit Function
    End If

    rawPath = BuildUniqueTempFilePath(exportRoot, "front-panel-", ".rgb")
    If Not TryWriteByteArrayToFile(imageData, rawPath, errorMessage) Then
        DeleteFileIfExists rawPath
        CloseFrontPanelSafe viRef
        Exit Function
    End If

    If Not TryConvertRawRgbToPng(rawPath, width, height, outputPath, errorMessage) Then
        DeleteFileIfExists rawPath
        CloseFrontPanelSafe viRef
        Exit Function
    End If

    DeleteFileIfExists rawPath
    CloseFrontPanelSafe viRef
    TryCaptureFrontPanelPng = True
End Function

Function TryOpenFrontPanel(ByRef viRef, ByRef errorMessage)
    Dim hiddenError

    TryOpenFrontPanel = False
    errorMessage = ""
    hiddenError = ""

    On Error Resume Next
    Err.Clear
    viRef.OpenFrontPanel False, FP_STATE_HIDDEN
    If Err.Number = 0 Then
        On Error GoTo 0
        TryOpenFrontPanel = True
        Exit Function
    End If

    hiddenError = Err.Description
    Err.Clear
    viRef.OpenFrontPanel False, FP_STATE_VISIBLE
    If Err.Number <> 0 Then
        errorMessage = "OpenFrontPanel failed: hidden=" & hiddenError & "; visible=" & Err.Description
        Err.Clear
        On Error GoTo 0
        Exit Function
    End If
    On Error GoTo 0

    TryOpenFrontPanel = True
End Function

Sub CloseFrontPanelSafe(ByRef viRef)
    On Error Resume Next
    Err.Clear
    viRef.CloseFrontPanel
    Err.Clear
    On Error GoTo 0
End Sub

Function TryReadPanelBounds(ByVal bounds, ByRef width, ByRef height, ByRef errorMessage)
    Dim lowerBound
    Dim upperBound
    Dim leftPos
    Dim topPos
    Dim rightPos
    Dim bottomPos

    TryReadPanelBounds = False
    width = 0
    height = 0
    errorMessage = ""

    If Not TryGetArrayBounds(bounds, lowerBound, upperBound, errorMessage) Then
        errorMessage = "GetPanelImage returned invalid bounds. " & errorMessage
        Exit Function
    End If
    If (upperBound - lowerBound + 1) < 4 Then
        errorMessage = "GetPanelImage returned incomplete bounds."
        Exit Function
    End If

    On Error Resume Next
    Err.Clear
    leftPos = CLng(bounds(lowerBound))
    topPos = CLng(bounds(lowerBound + 1))
    rightPos = CLng(bounds(lowerBound + 2))
    bottomPos = CLng(bounds(lowerBound + 3))
    If Err.Number <> 0 Then
        errorMessage = "GetPanelImage returned unreadable bounds."
        Err.Clear
        On Error GoTo 0
        Exit Function
    End If
    On Error GoTo 0

    width = rightPos - leftPos
    height = bottomPos - topPos
    If width <= 0 Or height <= 0 Then
        errorMessage = "GetPanelImage returned non-positive bounds: " & CStr(leftPos) & "," & CStr(topPos) & "," & CStr(rightPos) & "," & CStr(bottomPos)
        Exit Function
    End If

    TryReadPanelBounds = True
End Function

Function TryGetArrayBounds(ByVal values, ByRef lowerBound, ByRef upperBound, ByRef errorMessage)
    TryGetArrayBounds = False
    lowerBound = 0
    upperBound = -1
    errorMessage = ""

    If Not IsArray(values) Then
        errorMessage = "Value is not an array."
        Exit Function
    End If

    On Error Resume Next
    Err.Clear
    lowerBound = LBound(values)
    upperBound = UBound(values)
    If Err.Number <> 0 Then
        errorMessage = Err.Description
        Err.Clear
        On Error GoTo 0
        Exit Function
    End If
    On Error GoTo 0

    TryGetArrayBounds = True
End Function

Function TryWriteByteArrayToFile(ByRef bytes, ByVal filePath, ByRef errorMessage)
    Dim stream

    TryWriteByteArrayToFile = False
    errorMessage = ""

    On Error Resume Next
    Set stream = CreateObject("ADODB.Stream")
    stream.Type = 1
    stream.Open
    stream.Write bytes
    If Err.Number <> 0 Then
        errorMessage = "Failed to write raw image bytes: " & Err.Description
        Err.Clear
        On Error GoTo 0
        Exit Function
    End If

    EnsureParentFolder filePath
    DeleteFileIfExists filePath
    stream.SaveToFile filePath, 2
    If Err.Number <> 0 Then
        errorMessage = "Failed to save raw image bytes: " & Err.Description
        Err.Clear
        stream.Close
        On Error GoTo 0
        Exit Function
    End If
    stream.Close
    On Error GoTo 0

    TryWriteByteArrayToFile = True
End Function

Function TryConvertRawRgbToPng(ByVal rawPath, ByVal width, ByVal height, ByVal outputPath, ByRef errorMessage)
    Dim shell
    Dim exec
    Dim command
    Dim scriptPath
    Dim stderrText
    Dim stdoutText

    TryConvertRawRgbToPng = False
    errorMessage = ""
    scriptPath = BuildUniqueTempFilePath(GetTempFolder(), "labview-rgb-to-png-", ".ps1")

    If Not TryWriteAsciiTextFile(scriptPath, BuildRawRgbToPngPowerShellScript(), errorMessage) Then
        Exit Function
    End If

    command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -Command " _
        & QuoteArg("& " & QuotePowerShellLiteral(scriptPath) _
        & " -RawPath " & QuotePowerShellLiteral(rawPath) _
        & " -Width " & CStr(width) _
        & " -Height " & CStr(height) _
        & " -OutputPath " & QuotePowerShellLiteral(outputPath))

    On Error Resume Next
    Set shell = CreateObject("WScript.Shell")
    Set exec = shell.Exec(command)
    If Err.Number <> 0 Then
        errorMessage = "Failed to start PowerShell RGB conversion: " & Err.Description
        Err.Clear
        DeleteFileIfExists scriptPath
        On Error GoTo 0
        Exit Function
    End If
    On Error GoTo 0

    Do While exec.Status = 0
        WScript.Sleep 100
    Loop

    stderrText = ""
    stdoutText = ""
    On Error Resume Next
    If Not exec.StdErr.AtEndOfStream Then stderrText = Trim(exec.StdErr.ReadAll)
    If Not exec.StdOut.AtEndOfStream Then stdoutText = Trim(exec.StdOut.ReadAll)
    On Error GoTo 0
    If exec.ExitCode <> 0 Then
        DeleteFileIfExists scriptPath
        errorMessage = stderrText
        If Len(errorMessage) = 0 Then
            errorMessage = stdoutText
        End If
        If Len(errorMessage) = 0 Then
            errorMessage = "PowerShell RGB conversion failed with exit code " & CStr(exec.ExitCode) & "."
        End If
        Exit Function
    End If

    If Not FileExists(outputPath) Then
        DeleteFileIfExists scriptPath
        errorMessage = "PowerShell RGB conversion exited successfully but did not create output file."
        If Len(stderrText) > 0 Then
            errorMessage = errorMessage & " stderr=" & stderrText
        End If
        If Len(stdoutText) > 0 Then
            errorMessage = errorMessage & " stdout=" & stdoutText
        End If
        Exit Function
    End If

    DeleteFileIfExists scriptPath

    TryConvertRawRgbToPng = True
End Function

Function TryWriteAsciiTextFile(ByVal filePath, ByVal text, ByRef errorMessage)
    Dim fso
    Dim stream

    TryWriteAsciiTextFile = False
    errorMessage = ""

    On Error Resume Next
    Set fso = CreateObject("Scripting.FileSystemObject")
    EnsureParentFolder filePath
    DeleteFileIfExists filePath
    Set stream = fso.CreateTextFile(filePath, True, False)
    stream.Write text
    stream.Close
    If Err.Number <> 0 Then
        errorMessage = "Failed to write helper PowerShell script: " & Err.Description
        Err.Clear
        On Error GoTo 0
        Exit Function
    End If
    On Error GoTo 0

    TryWriteAsciiTextFile = True
End Function

Function QuotePowerShellLiteral(ByVal text)
    QuotePowerShellLiteral = "'" & Replace(text, "'", "''") & "'"
End Function

Function BuildRawRgbToPngPowerShellScript()
    Dim lines(20)

    lines(0) = "param([string]$RawPath, [int]$Width, [int]$Height, [string]$OutputPath)"
    lines(1) = "$ErrorActionPreference = 'Stop'"
    lines(2) = "Add-Type -AssemblyName System.Drawing"
    lines(3) = "$raw = [System.IO.File]::ReadAllBytes($RawPath)"
    lines(4) = "$expected = $Width * $Height * 3"
    lines(5) = "if ($raw.Length -ne $expected) { throw ""Raw RGB byte length mismatch. expected=$expected actual=$($raw.Length)."" }"
    lines(6) = "$bitmap = New-Object System.Drawing.Bitmap($Width, $Height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)"
    lines(7) = "$rect = New-Object System.Drawing.Rectangle 0, 0, $Width, $Height"
    lines(8) = "$data = $bitmap.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::WriteOnly, $bitmap.PixelFormat)"
    lines(9) = "try {"
    lines(10) = "  $stride = [Math]::Abs($data.Stride)"
    lines(11) = "  $buffer = New-Object byte[] ($stride * $Height)"
    lines(12) = "  for ($y = 0; $y -lt $Height; $y++) {"
    lines(13) = "    $srcRow = $y * $Width * 3; $destRow = $y * $stride"
    lines(14) = "    for ($x = 0; $x -lt $Width; $x++) {"
    lines(15) = "      $src = $srcRow + ($x * 3); $dest = $destRow + ($x * 3); $buffer[$dest] = $raw[$src + 2]; $buffer[$dest + 1] = $raw[$src + 1]; $buffer[$dest + 2] = $raw[$src]"
    lines(16) = "    }"
    lines(17) = "  }"
    lines(18) = "  [Runtime.InteropServices.Marshal]::Copy($buffer, 0, $data.Scan0, $buffer.Length)"
    lines(19) = "} finally { $bitmap.UnlockBits($data) }"
    lines(20) = "$directory = Split-Path -Parent $OutputPath; if ($directory) { [System.IO.Directory]::CreateDirectory($directory) | Out-Null }; if (Test-Path $OutputPath) { Remove-Item $OutputPath -Force }; $bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png); $bitmap.Dispose()"
    BuildRawRgbToPngPowerShellScript = Join(lines, vbCrLf)
End Function

Function TryWriteRgbBmp(ByRef imageData, ByVal imageLowerBound, ByVal width, ByVal height, ByVal bmpPath, ByRef errorMessage)
    Dim stream
    Dim rowStride
    Dim padding
    Dim imageSize
    Dim rowIndex
    Dim rowStart
    Dim paddingText

    TryWriteRgbBmp = False
    errorMessage = ""
    rowStride = CLng(width) * 3
    padding = (4 - (rowStride Mod 4)) Mod 4
    imageSize = (rowStride + padding) * CLng(height)
    paddingText = RepeatByte(0, padding)

    On Error Resume Next
    Set stream = CreateObject("ADODB.Stream")
    stream.Type = 2
    stream.Charset = "iso-8859-1"
    stream.Open
    stream.WriteText BuildBmpHeader(width, height, imageSize)
    If Err.Number <> 0 Then
        errorMessage = "Failed to initialize BMP stream: " & Err.Description
        Err.Clear
        On Error GoTo 0
        Exit Function
    End If

    For rowIndex = height - 1 To 0 Step -1
        rowStart = imageLowerBound + (CLng(rowIndex) * rowStride)
        stream.WriteText BuildBmpPixelRow(imageData, rowStart, width)
        If padding > 0 Then
            stream.WriteText paddingText
        End If
        If Err.Number <> 0 Then
            errorMessage = "Failed while writing BMP row data: " & Err.Description
            Err.Clear
            stream.Close
            On Error GoTo 0
            Exit Function
        End If
    Next

    EnsureParentFolder bmpPath
    DeleteFileIfExists bmpPath
    stream.SaveToFile bmpPath, 2
    If Err.Number <> 0 Then
        errorMessage = "Failed to save BMP file: " & Err.Description
        Err.Clear
        stream.Close
        On Error GoTo 0
        Exit Function
    End If
    stream.Close
    On Error GoTo 0

    TryWriteRgbBmp = True
End Function

Function TryConvertBmpToPng(ByVal bmpPath, ByVal outputPath, ByRef errorMessage)
    Dim imageFile
    Dim imageProcess
    Dim filterId
    Dim converted

    TryConvertBmpToPng = False
    errorMessage = ""

    On Error Resume Next
    Set imageFile = CreateObject("WIA.ImageFile")
    imageFile.LoadFile bmpPath
    If Err.Number <> 0 Then
        errorMessage = "WIA load failed: " & Err.Description
        Err.Clear
        On Error GoTo 0
        Exit Function
    End If

    Set imageProcess = CreateObject("WIA.ImageProcess")
    If Err.Number <> 0 Then
        errorMessage = "WIA process creation failed: " & Err.Description
        Err.Clear
        On Error GoTo 0
        Exit Function
    End If

    filterId = imageProcess.FilterInfos.Item("Convert").FilterID
    imageProcess.Filters.Add filterId
    imageProcess.Filters.Item(1).Properties.Item("FormatID").Value = WIA_FORMAT_PNG
    Set converted = imageProcess.Apply(imageFile)
    If Err.Number <> 0 Then
        errorMessage = "WIA PNG conversion failed: " & Err.Description
        Err.Clear
        On Error GoTo 0
        Exit Function
    End If

    EnsureParentFolder outputPath
    DeleteFileIfExists outputPath
    converted.SaveFile outputPath
    If Err.Number <> 0 Then
        errorMessage = "Saving PNG failed: " & Err.Description
        Err.Clear
        On Error GoTo 0
        Exit Function
    End If
    On Error GoTo 0

    TryConvertBmpToPng = True
End Function

Function BuildBmpHeader(ByVal width, ByVal height, ByVal imageSize)
    Dim fileSize
    Dim parts(13)

    fileSize = BMP_PIXEL_DATA_OFFSET + imageSize
    parts(0) = "BM"
    parts(1) = UInt32LE(fileSize)
    parts(2) = UInt16LE(0)
    parts(3) = UInt16LE(0)
    parts(4) = UInt32LE(BMP_PIXEL_DATA_OFFSET)
    parts(5) = UInt32LE(BMP_INFO_HEADER_SIZE)
    parts(6) = UInt32LE(width)
    parts(7) = UInt32LE(height)
    parts(8) = UInt16LE(1)
    parts(9) = UInt16LE(24)
    parts(10) = UInt32LE(0)
    parts(11) = UInt32LE(imageSize)
    parts(12) = UInt32LE(BMP_PIXELS_PER_METER)
    parts(13) = UInt32LE(BMP_PIXELS_PER_METER) & UInt32LE(0) & UInt32LE(0)
    BuildBmpHeader = Join(parts, "")
End Function

Function BuildBmpPixelRow(ByRef imageData, ByVal rowStart, ByVal width)
    Dim column
    Dim sourceIndex
    Dim result

    result = ""
    For column = 0 To CLng(width) - 1
        sourceIndex = CLng(rowStart) + (CLng(column) * 3)
        result = result _
            & ByteChar(imageData(CLng(sourceIndex + 2))) _
            & ByteChar(imageData(CLng(sourceIndex + 1))) _
            & ByteChar(imageData(CLng(sourceIndex)))
    Next
    BuildBmpPixelRow = result
End Function

Function BuildUniqueTempFilePath(ByVal baseDir, ByVal prefix, ByVal suffix)
    Dim fso
    Dim fileName

    Set fso = CreateObject("Scripting.FileSystemObject")
    fileName = prefix & CreateGuidToken() & suffix
    BuildUniqueTempFilePath = fso.BuildPath(baseDir, fileName)
End Function

Sub DeleteFileIfExists(ByVal filePath)
    Dim fso

    Set fso = CreateObject("Scripting.FileSystemObject")
    On Error Resume Next
    If fso.FileExists(filePath) Then
        fso.DeleteFile filePath, True
    End If
    On Error GoTo 0
End Sub

Function RepeatByte(ByVal value, ByVal count)
    Dim index
    Dim result

    result = ""
    For index = 1 To count
        result = result & ByteChar(value)
    Next
    RepeatByte = result
End Function

Function ByteChar(ByVal value)
    Dim normalized

    normalized = CLng(value)
    If normalized < 0 Then
        normalized = normalized + 256
    End If
    ByteChar = ChrW(normalized And &HFF)
End Function

Function UInt16LE(ByVal value)
    UInt16LE = ByteChar(value And &HFF) _
        & ByteChar((value \ &H100) And &HFF)
End Function

Function UInt32LE(ByVal value)
    UInt32LE = ByteChar(value And &HFF) _
        & ByteChar((value \ &H100) And &HFF) _
        & ByteChar((value \ &H10000) And &HFF) _
        & ByteChar((value \ &H1000000) And &HFF)
End Function

Function FindExportedImage(ByVal imageDir, ByVal suffix)
    Dim fso
    Dim folder
    Dim file
    Dim bestPath

    Set fso = CreateObject("Scripting.FileSystemObject")
    bestPath = ""
    If Not fso.FolderExists(imageDir) Then
        FindExportedImage = ""
        Exit Function
    End If

    Set folder = fso.GetFolder(imageDir)
    For Each file In folder.Files
        If LCase(Right(file.Name, Len(suffix))) = LCase(suffix) Then
            If Len(bestPath) = 0 Or LCase(file.Path) < LCase(bestPath) Then
                bestPath = file.Path
            End If
        End If
    Next
    FindExportedImage = bestPath
End Function

Sub EnsureParentFolder(ByVal filePath)
    Dim fso
    Dim parentPath

    Set fso = CreateObject("Scripting.FileSystemObject")
    parentPath = fso.GetParentFolderName(filePath)
    If Len(parentPath) = 0 Then Exit Sub
    CreateFolderRecursive parentPath
End Sub

Sub CreateFolderRecursive(ByVal folderPath)
    Dim fso
    Dim parentPath

    Set fso = CreateObject("Scripting.FileSystemObject")
    If Len(folderPath) = 0 Or fso.FolderExists(folderPath) Then Exit Sub
    parentPath = fso.GetParentFolderName(folderPath)
    If Len(parentPath) > 0 And Not fso.FolderExists(parentPath) Then
        CreateFolderRecursive parentPath
    End If
    If Not fso.FolderExists(folderPath) Then
        fso.CreateFolder folderPath
    End If
End Sub

Sub CleanupFolder(ByVal folderPath)
    Dim fso
    Set fso = CreateObject("Scripting.FileSystemObject")
    On Error Resume Next
    If fso.FolderExists(folderPath) Then
        fso.DeleteFolder folderPath, True
    End If
    On Error GoTo 0
End Sub

Function GetTempFolder()
    Dim shell
    Set shell = CreateObject("WScript.Shell")
    GetTempFolder = shell.ExpandEnvironmentStrings("%TEMP%")
End Function

Function BuildUniqueTempDir(ByVal baseDir, ByVal prefix)
    Dim fso
    Dim candidate

    Set fso = CreateObject("Scripting.FileSystemObject")
    candidate = fso.BuildPath(baseDir, prefix & CreateGuidToken())
    BuildUniqueTempDir = candidate
End Function

Function CreateGuidToken()
    Dim guidText
    Dim nullPos

    guidText = Replace(Replace(CreateObject("Scriptlet.TypeLib").Guid, "{", ""), "}", "")
    nullPos = InStr(guidText, Chr(0))
    If nullPos > 0 Then
        guidText = Left(guidText, nullPos - 1)
    End If
    CreateGuidToken = guidText
End Function

Sub WriteResponse(ByVal ok)
    Dim fso
    Dim stream
    Set fso = CreateObject("Scripting.FileSystemObject")
    Set stream = fso.CreateTextFile(responsePath, True, False)

    stream.WriteLine "ok=" & IIf(ok, "1", "0")
    stream.WriteLine "selection=" & SafeAscii(selection)
    stream.WriteLine "reason_b64=" & EncodeBase64Utf8(reason)
    stream.WriteLine "connected_version_b64=" & EncodeBase64Utf8(connectedVersion)
    stream.WriteLine "connected_directory_b64=" & EncodeBase64Utf8(connectedDirectory)
    stream.WriteLine "attempts=" & CStr(attempts)
    stream.WriteLine "output_path_b64=" & EncodeBase64Utf8(exportedOutputPath)
    stream.WriteLine "fp_output_path_b64=" & EncodeBase64Utf8(exportedFpOutputPath)
    stream.WriteLine "bd_output_path_b64=" & EncodeBase64Utf8(exportedBdOutputPath)

    stream.Close
    Set stream = Nothing
    Set fso = Nothing
End Sub

Sub ConnectLabVIEW()
    Dim deadlineMs
    Dim expectedDirNorm
    Dim createErr
    Dim lastMismatch

    deadlineMs = DateAdd("s", timeoutSeconds, Now())
    expectedDirNorm = NormalizePath(expectedDirectory)
    createErr = ""
    lastMismatch = ""

    If TryReuseRunningLabVIEW(expectedDirNorm, lastMismatch) Then
        Exit Sub
    End If

    Do While Now() < deadlineMs
        attempts = attempts + 1

        If ShouldActivateTargetInstance(attempts) Then
            StartTargetLabVIEW targetExe
            If WaitForReusableTargetInstance(expectedDirNorm, 2500, lastMismatch) Then
                Exit Sub
            End If
        End If

        On Error Resume Next
        Err.Clear
        Set app = CreateObject("LabVIEW.Application")
        If Err.Number = 0 Then
            Dim appDir
            Dim appVer
            appDir = SafeGetAppDirectory(app)
            appVer = SafeGetAppVersion(app)
            connectedDirectory = appDir
            connectedVersion = appVer

            If Len(targetExe) = 0 Then
                If Len(expectedVersion) = 0 And Len(expectedDirectory) = 0 Then
                    selection = "created-default-labview-application"
                    reason = "No reusable LabVIEW instance was available. Created a new automation instance."
                    Exit Sub
                End If
                If MatchesTarget(appDir, appVer, expectedDirNorm, expectedVersion) Then
                    selection = "created-target-labview-application"
                    reason = "Created or attached a LabVIEW automation instance for the requested target."
                    Exit Sub
                End If
                lastMismatch = "Connected to " & DescribeApp(appDir, appVer) & ", which does not match the requested target."
                ReleaseComObject app
            Else
                If MatchesTarget(appDir, appVer, expectedDirNorm, expectedVersion) Then
                    selection = "created-target-labview-application"
                    reason = "Created or attached a LabVIEW automation instance for the requested installation."
                    Exit Sub
                End If
                lastMismatch = "Connected to " & DescribeApp(appDir, appVer) & ", which does not match the requested target installation."
                ReleaseComObject app
            End If
        Else
            createErr = "CreateObject failed: " & Err.Description
            Err.Clear
        End If
        On Error GoTo 0

        WScript.Sleep retryIntervalMs
    Loop

    selection = "failed-to-match-target-labview-application"
    If Len(lastMismatch) > 0 Then
        Err.Raise vbObjectError + 108, , lastMismatch
    End If
    If Len(createErr) > 0 Then
        selection = "failed-to-create-labview-application"
        Err.Raise vbObjectError + 109, , createErr
    End If
    Err.Raise vbObjectError + 108, , "Connection timed out."
End Sub

Function TryReuseRunningLabVIEW(ByVal expectedDirNorm, ByRef mismatchMessage)
    Dim candidate
    Dim appDir
    Dim appVer

    mismatchMessage = ""
    TryReuseRunningLabVIEW = False

    On Error Resume Next
    Set candidate = Nothing
    Err.Clear
    Set candidate = GetObject(, "LabVIEW.Application")
    If Err.Number <> 0 Then
        Err.Clear
        On Error GoTo 0
        Exit Function
    End If

    appDir = SafeGetAppDirectory(candidate)
    appVer = SafeGetAppVersion(candidate)
    connectedDirectory = appDir
    connectedVersion = appVer

    If MatchesTarget(appDir, appVer, expectedDirNorm, expectedVersion) Then
        Set app = candidate
        If Len(targetExe) > 0 Or Len(expectedVersion) > 0 Or Len(expectedDirectory) > 0 Then
            selection = "reused-running-labview-application"
            reason = "Reused an already running LabVIEW instance matching the requested target."
        Else
            selection = "reused-default-labview-application"
            reason = "Reused the current LabVIEW instance."
        End If
        TryReuseRunningLabVIEW = True
    Else
        mismatchMessage = "Connected to " & DescribeApp(appDir, appVer) & ", which does not match the requested target."
        ReleaseComObject candidate
    End If
    On Error GoTo 0
End Function

Function WaitForReusableTargetInstance(ByVal expectedDirNorm, ByVal waitMilliseconds, ByRef mismatchMessage)
    Dim elapsedMilliseconds

    WaitForReusableTargetInstance = False
    elapsedMilliseconds = 0

    Do While elapsedMilliseconds < waitMilliseconds
        WScript.Sleep 200
        elapsedMilliseconds = elapsedMilliseconds + 200
        If TryReuseRunningLabVIEW(expectedDirNorm, mismatchMessage) Then
            WaitForReusableTargetInstance = True
            Exit Function
        End If
    Loop
End Function

Function ShouldActivateTargetInstance(ByVal attemptNumber)
    If Len(targetExe) = 0 Then
        ShouldActivateTargetInstance = False
        Exit Function
    End If
    ShouldActivateTargetInstance = (attemptNumber = 1 Or (attemptNumber Mod 2 = 0))
End Function

Sub StartTargetLabVIEW(ByVal exePath)
    Dim shell
    On Error Resume Next
    Set shell = CreateObject("WScript.Shell")
    If Err.Number = 0 Then
        shell.Run QuoteArg(exePath) & " /Automation", 0, False
        Err.Clear
    End If
    On Error GoTo 0
End Sub

Function DescribeApp(ByVal appDir, ByVal appVer)
    If Len(appDir) > 0 Then
        DescribeApp = appDir
        Exit Function
    End If
    If Len(appVer) > 0 Then
        DescribeApp = "LabVIEW " & appVer
        Exit Function
    End If
    DescribeApp = "unknown-instance"
End Function

Function IsTargetProcessRunning(ByVal exePath)
    Dim service
    Dim processList
    Dim processItem
    Dim processPath

    IsTargetProcessRunning = False

    On Error Resume Next
    Set service = GetObject("winmgmts:root\cimv2")
    If Err.Number <> 0 Then Err.Clear : Exit Function

    Set processList = service.ExecQuery( _
        "SELECT ExecutablePath FROM Win32_Process WHERE Name='LabVIEW.exe'")
    If Err.Number <> 0 Then Err.Clear : Exit Function

    For Each processItem In processList
        processPath = ""
        If Not IsNull(processItem.ExecutablePath) Then
            processPath = NormalizePath(CStr(processItem.ExecutablePath))
        End If
        If processPath = NormalizePath(exePath) Then
            IsTargetProcessRunning = True
            Exit Function
        End If
    Next
    On Error GoTo 0
End Function

Sub MaybeLaunchTarget(ByRef shell)
    On Error Resume Next
    shell.Run QuoteArg(targetExe) & " /Automation", 0, False
    On Error GoTo 0
End Sub

Function MatchesTarget(ByVal appDir, ByVal appVer, ByVal expectedDirNorm, ByVal expectedVer)
    MatchesTarget = False
    If Len(expectedDirNorm) > 0 Then
        If NormalizePath(appDir) = expectedDirNorm Then
            MatchesTarget = True
        End If
        Exit Function
    End If
    If Len(expectedVer) > 0 Then
        If LCase(Left(appVer, Len(expectedVer))) = LCase(expectedVer) Then
            MatchesTarget = True
            Exit Function
        End If
    End If
    If Len(expectedDirNorm) = 0 And Len(expectedVer) = 0 Then
        MatchesTarget = True
    End If
End Function

Function SafeGetAppDirectory(ByRef appRef)
    On Error Resume Next
    SafeGetAppDirectory = CStr(appRef.ApplicationDirectory)
    If Err.Number <> 0 Then SafeGetAppDirectory = "" : Err.Clear
    On Error GoTo 0
End Function

Function SafeGetAppVersion(ByRef appRef)
    On Error Resume Next
    SafeGetAppVersion = CStr(appRef.Version)
    If Err.Number <> 0 Then SafeGetAppVersion = "" : Err.Clear
    On Error GoTo 0
End Function

Function NormalizePath(ByVal pathText)
    Dim fso
    Set fso = CreateObject("Scripting.FileSystemObject")
    If Len(pathText) = 0 Then
        NormalizePath = ""
    Else
        NormalizePath = LCase(fso.GetAbsolutePathName(pathText))
    End If
End Function

Function FileExists(ByVal filePath)
    Dim fso
    Set fso = CreateObject("Scripting.FileSystemObject")
    FileExists = fso.FileExists(filePath)
End Function

Sub ReleaseComObject(ByRef objRef)
    On Error Resume Next
    Set objRef = Nothing
    On Error GoTo 0
End Sub

Function GetNamedArg(ByVal key, ByVal defaultValue)
    Dim prefix
    Dim arg
    prefix = "/" & LCase(key) & ":"
    For Each arg In WScript.Arguments
        If LCase(Left(arg, Len(prefix))) = prefix Then
            GetNamedArg = Mid(arg, Len(prefix) + 1)
            Exit Function
        End If
    Next
    GetNamedArg = defaultValue
End Function

Function SafeAscii(ByVal text)
    Dim i
    Dim ch
    Dim code
    Dim result
    result = ""
    For i = 1 To Len(text)
        ch = Mid(text, i, 1)
        code = AscW(ch)
        If code >= 32 And code <= 126 Then
            result = result & ch
        Else
            result = result & "?"
        End If
    Next
    SafeAscii = result
End Function

Function EncodeBase64Utf8(ByVal text)
    Dim stream
    Dim bytes
    Dim xml
    Dim node

    Set stream = CreateObject("ADODB.Stream")
    stream.Type = 2
    stream.Charset = "utf-8"
    stream.Open
    stream.WriteText text
    stream.Position = 0
    stream.Type = 1
    bytes = stream.Read
    stream.Close

    Set xml  = CreateObject("MSXML2.DOMDocument.6.0")
    Set node = xml.createElement("b64")
    node.DataType = "bin.base64"
    node.nodeTypedValue = bytes
    EncodeBase64Utf8 = Replace(Replace(node.Text, vbCr, ""), vbLf, "")
End Function

Function QuoteArg(ByVal text)
    QuoteArg = Chr(34) & Replace(text, Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function

Function IIf(ByVal condition, ByVal trueValue, ByVal falseValue)
    If condition Then
        IIf = trueValue
    Else
        IIf = falseValue
    End If
End Function
