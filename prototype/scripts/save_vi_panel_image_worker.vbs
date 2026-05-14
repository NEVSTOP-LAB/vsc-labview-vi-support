Option Explicit

' ===========================================================================
' save_vi_panel_image_worker.vbs
' ===========================================================================
' 使用 LabVIEW ActiveX/COM 的 PrintVIToHTML 导出前面板和/或程序框图 PNG。
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

    Set fso = CreateObject("Scripting.FileSystemObject")
    tempRoot = GetTempFolder()
    exportRoot = BuildUniqueTempDir(tempRoot, "lv-html-export-")
    htmlPath = fso.BuildPath(exportRoot, "export.html")
    imageDir = fso.BuildPath(exportRoot, "images")

    If Not fso.FolderExists(exportRoot) Then fso.CreateFolder exportRoot
    If Not fso.FolderExists(imageDir) Then fso.CreateFolder imageDir

    Err.Clear
    viRef.PrintVIToHTML htmlPath, False, PRINT_FORMAT_COMPLETE, HTML_IMAGE_FORMAT_PNG, 24, imageDir
    If Err.Number <> 0 Then
        Dim invokeErr
        invokeErr = Err.Description
        CleanupFolder exportRoot
        Err.Raise vbObjectError + 106, , "PrintVIToHTML failed: " & invokeErr
        Exit Sub
    End If

    If Len(fpFinalOutputPath) > 0 Then
        sourcePath = FindExportedImage(imageDir, "p.png")
        If Len(sourcePath) = 0 Then
            CleanupFolder exportRoot
            Err.Raise vbObjectError + 107, , "LabVIEW HTML export did not produce *p.png."
            Exit Sub
        End If
        EnsureParentFolder fpFinalOutputPath
        fso.CopyFile sourcePath, fpFinalOutputPath, True
        exportedFpOutputPath = fpFinalOutputPath
    End If

    If Len(bdFinalOutputPath) > 0 Then
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
    Dim shell

    Set fso = CreateObject("Scripting.FileSystemObject")
    Set shell = CreateObject("Scriptlet.TypeLib")
    candidate = fso.BuildPath(baseDir, prefix & Replace(Replace(shell.Guid, "{", ""), "}", ""))
    BuildUniqueTempDir = candidate
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
    Dim shell
    Dim deadlineMs
    Dim expectedDirNorm

    Set shell = CreateObject("WScript.Shell")
    deadlineMs = DateAdd("s", timeoutSeconds, Now())
    expectedDirNorm = NormalizePath(expectedDirectory)

    Do While Now() < deadlineMs
        attempts = attempts + 1

        If Len(targetExe) > 0 And attempts = 1 Then
            MaybeLaunchTarget shell
        End If

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
                    selection = "connected-default-labview-application"
                    reason = "No target version specified. Used the current default instance."
                    Exit Sub
                End If
                If MatchesTarget(appDir, appVer, expectedDirNorm, expectedVersion) Then
                    selection = "matched-target-labview-application"
                    reason = "Connected to a LabVIEW instance matching the requested target."
                    Exit Sub
                End If
                reason = "Connected LabVIEW instance does not match the requested target."
                ReleaseComObject app
            Else
                If MatchesTarget(appDir, appVer, expectedDirNorm, expectedVersion) Then
                    selection = "matched-target-labview-application"
                    reason = "Connected to the requested LabVIEW installation."
                    Exit Sub
                End If
                reason = "Connected LabVIEW instance does not match the requested target installation."
                ReleaseComObject app
            End If
        Else
            reason = Err.Description
            Err.Clear
        End If

        If Len(targetExe) > 0 And attempts Mod 2 = 0 Then
            MaybeLaunchTarget shell
        End If
        WScript.Sleep retryIntervalMs
    Loop

    selection = "failed-to-match-target-labview-application"
    If Len(reason) = 0 Then reason = "Connection timed out."
    Err.Raise vbObjectError + 108, , reason
End Sub

Sub MaybeLaunchTarget(ByRef shell)
    On Error Resume Next
    shell.Run QuoteArg(targetExe) & " /Automation", 0, False
    On Error GoTo 0
End Sub

Function MatchesTarget(ByVal appDir, ByVal appVer, ByVal expectedDirNorm, ByVal expectedVer)
    MatchesTarget = False
    If Len(expectedDirNorm) > 0 Then
        If NormalizePath(appDir) <> expectedDirNorm Then Exit Function
    End If
    If Len(expectedVer) > 0 Then
        If LCase(Left(appVer, Len(expectedVer))) <> LCase(expectedVer) Then Exit Function
    End If
    If Len(expectedDirNorm) = 0 And Len(expectedVer) = 0 Then
        Exit Function
    End If
    MatchesTarget = True
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