Option Explicit

' ===========================================================================
' read_vi_props_worker.vbs
' ===========================================================================
' 通过 LabVIEW ActiveX/COM 读取一组常用且稳定可访问的 VI 属性。
'
' 本脚本由扩展运行时通过 cscript.exe 调度。
'
' 命名参数（由扩展运行时以 /key:value 形式传入）
' -----------------------------------------
'   /viPath             VI 文件完整路径（必填）
'   /responsePath       结果输出文件路径（必填）
'   /timeoutSeconds     连接超时秒数（默认 45）
'   /targetExe          目标 LabVIEW.exe 路径（可选；有则精确匹配）
'   /expectedDirectory  预期的 ApplicationDirectory（可选）
'   /expectedVersion    预期的 Version 前缀，例如 "17.0"（可选）
'
' 响应文件格式（ASCII 编码）
' -------------------------
'   ok=1|0
'   selection=<ascii>
'   reason_b64=<Base64-UTF8>
'   connected_version_b64=<Base64-UTF8>
'   connected_directory_b64=<Base64-UTF8>
'   attempts=<整数>
'   prop_<Name>_type=String|Boolean|Number
'   prop_<Name>_ok=1|0
'   prop_<Name>_val=<Base64-UTF8>       (ok=1 时)
'   prop_<Name>_errmsg=<Base64-UTF8>    (ok=0 时)
'   ...（每个属性三行）
' ===========================================================================

' ---------------------------------------------------------------------------
' 读取命名参数
' ---------------------------------------------------------------------------
Dim viPath
Dim targetExe
Dim expectedDirectory
Dim expectedVersion
Dim responsePath
Dim timeoutSeconds
Dim retryIntervalMs

viPath            = GetNamedArg("viPath", "")
targetExe         = GetNamedArg("targetExe", "")
expectedDirectory = GetNamedArg("expectedDirectory", "")
expectedVersion   = GetNamedArg("expectedVersion", "")
responsePath      = GetNamedArg("responsePath", "")
timeoutSeconds    = CLng(GetNamedArg("timeoutSeconds", "45"))
retryIntervalMs   = 750

' ---------------------------------------------------------------------------
' 运行时状态
' ---------------------------------------------------------------------------
Dim app
Dim vi
Dim attempts
Dim selection
Dim reason
Dim connectedVersion
Dim connectedDirectory

Set app            = Nothing
Set vi             = Nothing
attempts           = 0
selection          = ""
reason             = ""
connectedVersion   = ""
connectedDirectory = ""

' ---------------------------------------------------------------------------
' 顶层执行
' ---------------------------------------------------------------------------
On Error Resume Next
Main
If Err.Number <> 0 Then
    reason = Err.Description
    WriteFailResponse selection, reason, connectedVersion, connectedDirectory, attempts
    WScript.Quit 3
End If
On Error GoTo 0

' ===========================================================================
' Sub Main
' ===========================================================================
Sub Main()
    If Len(responsePath) = 0 Then
        Err.Raise vbObjectError + 100, , "Missing responsePath argument."
    End If
    If Len(viPath) = 0 Then
        Err.Raise vbObjectError + 101, , "Missing viPath argument."
    End If
    If Not FileExists(viPath) Then
        Err.Raise vbObjectError + 102, , "VI file not found: " & viPath
    End If

    ConnectLabVIEW

    Err.Clear
    Set vi = app.GetVIReference(viPath)
    If Err.Number <> 0 Then
        Err.Raise vbObjectError + 103, , "GetVIReference failed: " & Err.Description
    End If

    Dim fso
    Dim stream
    Set fso    = CreateObject("Scripting.FileSystemObject")
    Set stream = fso.CreateTextFile(responsePath, True, False)

    stream.WriteLine "ok=1"
    stream.WriteLine "selection="             & SafeAscii(selection)
    stream.WriteLine "reason_b64="            & EncodeBase64Utf8(reason)
    stream.WriteLine "connected_version_b64=" & EncodeBase64Utf8(connectedVersion)
    stream.WriteLine "connected_directory_b64=" & EncodeBase64Utf8(connectedDirectory)
    stream.WriteLine "attempts="              & CStr(attempts)

    ReadAllProperties stream

    stream.Close
    Set stream = Nothing
    Set fso    = Nothing

    ReleaseComObject vi
    ReleaseComObject app
    WScript.Quit 0
End Sub

' ===========================================================================
' Sub ReadAllProperties  —  逐属性尝试读取，单个失败不影响其他属性
' ===========================================================================
Sub ReadAllProperties(ByRef stream)
    Dim val
    Dim ok
    Dim errMsg

    On Error Resume Next

    val = "" : Err.Clear
    val = CStr(vi.Name)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    WritePropLine stream, "Name", "String", ok, val, errMsg

    val = "" : Err.Clear
    val = CStr(vi.Path)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    WritePropLine stream, "Path", "String", ok, val, errMsg

    val = "" : Err.Clear
    val = ReadOwningAppSummary(vi)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    WritePropLine stream, "OwningApp", "String", ok, val, errMsg

    val = "" : Err.Clear
    val = CStr(vi.VIType)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    WritePropLine stream, "VIType", "Number", ok, val, errMsg

    val = "" : Err.Clear
    val = CStr(vi.Description)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    WritePropLine stream, "Description", "String", ok, val, errMsg

    val = "" : Err.Clear
    val = CStr(vi.RevisionNumber)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    WritePropLine stream, "RevisionNumber", "String", ok, val, errMsg

    val = "" : Err.Clear
    val = CStr(vi.EditMode)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    WritePropLine stream, "EditMode", "Boolean", ok, val, errMsg

    val = "" : Err.Clear
    val = CStr(vi.ExecState)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    WritePropLine stream, "ExecState", "Number", ok, val, errMsg

    val = "" : Err.Clear
    val = CStr(vi.RunOnOpen)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    WritePropLine stream, "RunOnOpen", "Boolean", ok, val, errMsg

    val = "" : Err.Clear
    val = CStr(vi.PreferredExecSystem)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    WritePropLine stream, "PreferredExecSystem", "Number", ok, val, errMsg

    val = "" : Err.Clear
    val = CStr(vi.ShowFPOnCall)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    WritePropLine stream, "ShowFPOnCall", "Boolean", ok, val, errMsg

    val = "" : Err.Clear
    val = CStr(vi.ShowFPOnLoad)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    WritePropLine stream, "ShowFPOnLoad", "Boolean", ok, val, errMsg

    val = "" : Err.Clear
    val = CStr(vi.AllowDebugging)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    WritePropLine stream, "AllowDebugging", "Boolean", ok, val, errMsg

    val = "" : Err.Clear
    val = CStr(vi.IsReentrant)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    WritePropLine stream, "IsReentrant", "Boolean", ok, val, errMsg

    val = "" : Err.Clear
    val = CStr(vi.ReentrancyType)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    WritePropLine stream, "ReentrancyType", "Number", ok, val, errMsg

    val = "" : Err.Clear
    val = CStr(vi.CloseFPAfterCall)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    WritePropLine stream, "CloseFPAfterCall", "Boolean", ok, val, errMsg

    val = "" : Err.Clear
    val = CStr(vi.FPState)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    WritePropLine stream, "FPState", "Number", ok, val, errMsg

    val = "" : Err.Clear
    val = FormatBoundsValue(vi.FPWinBounds)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    WritePropLine stream, "FPWinBounds", "String", ok, val, errMsg

    val = "" : Err.Clear
    val = CStr(vi.FPWinTitle)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    WritePropLine stream, "FPWinTitle", "String", ok, val, errMsg

    val = "" : Err.Clear
    val = CStr(vi.FPRunTransparently)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    WritePropLine stream, "FPRunTransparently", "Boolean", ok, val, errMsg

    val = "" : Err.Clear
    val = CStr(vi.FPTransparency)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    WritePropLine stream, "FPTransparency", "Number", ok, val, errMsg

    val = "" : Err.Clear
    val = CStr(vi.FPResizable)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    WritePropLine stream, "FPResizable", "Boolean", ok, val, errMsg

    val = "" : Err.Clear
    val = CStr(vi.FPMinimizable)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    WritePropLine stream, "FPMinimizable", "Boolean", ok, val, errMsg

    val = "" : Err.Clear
    val = CStr(vi.FPShowMenuBar)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    WritePropLine stream, "FPShowMenuBar", "Boolean", ok, val, errMsg

    val = "" : Err.Clear
    val = CStr(vi.TBVisible)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    WritePropLine stream, "TBVisible", "Boolean", ok, val, errMsg

    val = "" : Err.Clear
    val = CStr(vi.TBShowRunButton)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    WritePropLine stream, "TBShowRunButton", "Boolean", ok, val, errMsg

    val = "" : Err.Clear
    val = CStr(vi.TBShowAbortButton)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    WritePropLine stream, "TBShowAbortButton", "Boolean", ok, val, errMsg

    val = "" : Err.Clear
    val = CStr(vi.FPWinClosable)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    WritePropLine stream, "FPWinClosable", "Boolean", ok, val, errMsg

    val = "" : Err.Clear
    val = CStr(vi.BDSize)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    WritePropLine stream, "BDSize", "Number", ok, val, errMsg

    val = "" : Err.Clear
    val = CStr(vi.FPSize)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    WritePropLine stream, "FPSize", "Number", ok, val, errMsg

    val = "" : Err.Clear
    val = CStr(vi.CodeSize)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    WritePropLine stream, "CodeSize", "Number", ok, val, errMsg

    val = "" : Err.Clear
    val = CStr(vi.DataSize)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    WritePropLine stream, "DataSize", "Number", ok, val, errMsg

    On Error GoTo 0
End Sub

Function ReadOwningAppSummary(ByRef viRef)
    Dim owningApp
    Dim appDir
    Dim appVer

    ReadOwningAppSummary = ""
    Set owningApp = Nothing

    On Error Resume Next
    Err.Clear
    Set owningApp = viRef.OwningApp
    If Err.Number <> 0 Then
        Err.Clear
        On Error GoTo 0
        Exit Function
    End If

    appDir = SafeGetAppDirectory(owningApp)
    appVer = SafeGetAppVersion(owningApp)
    If Len(appVer) > 0 And Len(appDir) > 0 Then
        ReadOwningAppSummary = appVer & " | " & appDir
    ElseIf Len(appDir) > 0 Then
        ReadOwningAppSummary = appDir
    Else
        ReadOwningAppSummary = appVer
    End If

    ReleaseComObject owningApp
    On Error GoTo 0
End Function

Function FormatBoundsValue(ByVal bounds)
    Dim lowerBound
    Dim upperBound
    Dim index
    Dim parts()

    On Error Resume Next
    If IsArray(bounds) Then
        lowerBound = LBound(bounds)
        upperBound = UBound(bounds)
        If Err.Number = 0 Then
            ReDim parts(upperBound - lowerBound)
            For index = lowerBound To upperBound
                parts(index - lowerBound) = CStr(bounds(index))
            Next
            If Err.Number = 0 Then
                FormatBoundsValue = Join(parts, ",")
                On Error GoTo 0
                Exit Function
            End If
            Err.Clear
        End If
    End If
    FormatBoundsValue = CStr(bounds)
    On Error GoTo 0
End Function

' ===========================================================================
' 写入单个属性的响应行
' ===========================================================================
Sub WritePropLine(ByRef stream, ByVal key, ByVal propType, ByVal ok, ByVal val, ByVal errMsg)
    stream.WriteLine "prop_" & key & "_type=" & propType
    If ok Then
        stream.WriteLine "prop_" & key & "_ok=1"
        stream.WriteLine "prop_" & key & "_val=" & EncodeBase64Utf8(val)
    Else
        stream.WriteLine "prop_" & key & "_ok=0"
        stream.WriteLine "prop_" & key & "_errmsg=" & EncodeBase64Utf8(errMsg)
    End If
End Sub

' ===========================================================================
' 失败时写最小响应文件（不含属性数据）
' ===========================================================================
Sub WriteFailResponse(ByVal selectionVal, ByVal reasonVal, ByVal versionVal, ByVal directoryVal, ByVal attemptsVal)
    Dim fso
    Dim stream

    On Error Resume Next
    Set fso = CreateObject("Scripting.FileSystemObject")
    If Err.Number <> 0 Then WScript.Quit 3

    Set stream = fso.CreateTextFile(responsePath, True, False)
    If Err.Number <> 0 Then WScript.Quit 3

    stream.WriteLine "ok=0"
    stream.WriteLine "selection="               & SafeAscii(selectionVal)
    stream.WriteLine "reason_b64="              & EncodeBase64Utf8(reasonVal)
    stream.WriteLine "connected_version_b64="   & EncodeBase64Utf8(versionVal)
    stream.WriteLine "connected_directory_b64=" & EncodeBase64Utf8(directoryVal)
    stream.WriteLine "attempts="                & CStr(attemptsVal)
    stream.Close
    On Error GoTo 0
End Sub

' ===========================================================================
' ConnectLabVIEW  —  与 read_vi_description_worker.vbs 相同逻辑
' ===========================================================================
Sub ConnectLabVIEW()
    Dim deadline
    Dim createErr
    Dim lastMismatch
    Dim appDir
    Dim appVer

    createErr    = ""
    lastMismatch = ""
    deadline     = DateAdd("s", timeoutSeconds, Now)

    If TryReuseRunningLabVIEW(lastMismatch) Then
        Exit Sub
    End If

    Do While Now < deadline
        attempts = attempts + 1

        If ShouldActivateTargetInstance(attempts) Then
            StartTargetLabVIEW targetExe
            If WaitForReusableTargetInstance(2500, lastMismatch) Then
                Exit Sub
            End If
        End If

        On Error Resume Next
        Set app = Nothing
        Err.Clear
        Set app = CreateObject("LabVIEW.Application")

        If Err.Number <> 0 Then
            createErr = "CreateObject failed: " & Err.Description
            Err.Clear
        Else
            appDir = SafeGetAppDirectory(app)
            appVer = SafeGetAppVersion(app)
            connectedDirectory = appDir
            connectedVersion   = appVer

            If AppMatches(appDir, appVer) Then
                On Error GoTo 0
                If Len(targetExe) > 0 Then
                    selection = "created-target-labview-application"
                    reason    = "Created or attached a LabVIEW automation instance for the requested installation."
                Else
                    selection = "created-default-labview-application"
                    reason    = "No reusable LabVIEW instance was available. Created a new automation instance."
                End If
                Exit Sub
            End If

            lastMismatch = "Connected to " & DescribeApp(appDir, appVer) & _
                           ", which does not match the requested target."
            ReleaseComObject app
            Set app = Nothing
        End If
        On Error GoTo 0

        WScript.Sleep retryIntervalMs
    Loop

    If Len(lastMismatch) > 0 Then
        selection = "failed-to-match-target-labview-application"
        Err.Raise vbObjectError + 109, , lastMismatch
    End If

    selection = "failed-to-create-labview-application"
    Err.Raise vbObjectError + 110, , createErr
End Sub

Function TryReuseRunningLabVIEW(ByRef mismatchMessage)
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
    connectedVersion   = appVer

    If AppMatches(appDir, appVer) Then
        Set app = candidate
        If Len(targetExe) > 0 Then
            selection = "reused-running-labview-application"
            reason    = "Reused an already running LabVIEW instance matching the requested installation."
        Else
            selection = "reused-default-labview-application"
            reason    = "Reused the current LabVIEW instance."
        End If
        TryReuseRunningLabVIEW = True
    Else
        mismatchMessage = "Connected to " & DescribeApp(appDir, appVer) & _
                          ", which does not match the requested target."
        ReleaseComObject candidate
    End If
    On Error GoTo 0
End Function

Function WaitForReusableTargetInstance(ByVal waitMilliseconds, ByRef mismatchMessage)
    Dim elapsedMilliseconds

    WaitForReusableTargetInstance = False
    elapsedMilliseconds = 0

    Do While elapsedMilliseconds < waitMilliseconds
        WScript.Sleep 200
        elapsedMilliseconds = elapsedMilliseconds + 200
        If TryReuseRunningLabVIEW(mismatchMessage) Then
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

' ===========================================================================
' 匹配判断
' ===========================================================================
Function AppMatches(ByVal appDir, ByVal appVer)
    AppMatches = False
    If Len(expectedDirectory) > 0 Then
        If StrComp(NormalizePath(appDir), NormalizePath(expectedDirectory), vbTextCompare) = 0 Then
            AppMatches = True
        End If
        Exit Function
    End If
    If Len(expectedVersion) > 0 Then
        If LCase(Left(appVer, Len(expectedVersion))) = LCase(expectedVersion) Then
            AppMatches = True
            Exit Function
        End If
    End If
    If Len(expectedDirectory) = 0 And Len(expectedVersion) = 0 Then
        AppMatches = True
    End If
End Function

Function DescribeApp(ByVal appDir, ByVal appVer)
    If Len(appDir) > 0 Then DescribeApp = appDir : Exit Function
    If Len(appVer) > 0 Then DescribeApp = "LabVIEW " & appVer : Exit Function
    DescribeApp = "unknown-instance"
End Function

' ===========================================================================
' 进程管理
' ===========================================================================
Sub CleanupAutomationProcesses(ByVal exePath)
    Dim service
    Dim processList
    Dim processItem
    Dim commandLine
    Dim processPath

    On Error Resume Next
    Set service = GetObject("winmgmts:root\cimv2")
    If Err.Number <> 0 Then Err.Clear : Exit Sub

    Set processList = service.ExecQuery( _
        "SELECT ProcessId, CommandLine, ExecutablePath " & _
        "FROM Win32_Process WHERE Name='LabVIEW.exe'")
    If Err.Number <> 0 Then Err.Clear : Exit Sub

    For Each processItem In processList
        commandLine = LCase(NullToEmpty(processItem.CommandLine))
        processPath = NormalizePath(NullToEmpty(processItem.ExecutablePath))
        If processPath = NormalizePath(exePath) Then
            If InStr(1, commandLine, "/automation", vbTextCompare) > 0 Then
                Err.Clear
                processItem.Terminate
                Err.Clear
            End If
        End If
    Next
    On Error GoTo 0
End Sub

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

Sub StartTargetLabVIEW(ByVal exePath)
    Dim shell
    On Error Resume Next
    Set shell = CreateObject("WScript.Shell")
    If Err.Number = 0 Then
        shell.Run Quote(exePath) & " /Automation", 0, False
        Err.Clear
    End If
    On Error GoTo 0
End Sub

' ===========================================================================
' 工具函数
' ===========================================================================
Function GetNamedArg(ByVal key, ByVal defaultValue)
    If WScript.Arguments.Named.Exists(key) Then
        GetNamedArg = WScript.Arguments.Named.Item(key)
    Else
        GetNamedArg = defaultValue
    End If
End Function

Function FileExists(ByVal pathText)
    Dim fso
    Set fso   = CreateObject("Scripting.FileSystemObject")
    FileExists = fso.FileExists(pathText)
End Function

Function NormalizePath(ByVal pathText)
    Dim normalized
    normalized = Replace(Trim(NullToEmpty(pathText)), "/", "\")
    Do While Len(normalized) > 0 And Right(normalized, 1) = "\"
        normalized = Left(normalized, Len(normalized) - 1)
    Loop
    NormalizePath = LCase(normalized)
End Function

Function NullToEmpty(ByVal value)
    If IsNull(value) Then NullToEmpty = "" Else NullToEmpty = CStr(value)
End Function

Function Quote(ByVal text)
    Quote = Chr(34) & text & Chr(34)
End Function

Function SafeAscii(ByVal value)
    SafeAscii = Replace(Replace(NullToEmpty(value), vbCr, " "), vbLf, " ")
End Function

Function SafeGetAppDirectory(ByRef appRef)
    Err.Clear
    SafeGetAppDirectory = CStr(appRef.ApplicationDirectory)
    If Err.Number <> 0 Then SafeGetAppDirectory = "" : Err.Clear
End Function

Function SafeGetAppVersion(ByRef appRef)
    Err.Clear
    SafeGetAppVersion = CStr(appRef.Version)
    If Err.Number <> 0 Then SafeGetAppVersion = "" : Err.Clear
End Function

' ===========================================================================
' Base64 编码 / 解码（ADODB.Stream + Msxml2.DOMDocument.6.0）
' ===========================================================================
Function EncodeBase64Utf8(ByVal text)
    Dim stream
    Dim xml
    Dim node
    Dim bytes

    Set stream     = CreateObject("ADODB.Stream")
    stream.Type    = 2       ' adTypeText
    stream.Charset = "utf-8"
    stream.Open
    stream.WriteText NullToEmpty(text)
    stream.Position = 0
    stream.Type    = 1       ' adTypeBinary
    bytes          = stream.Read
    stream.Close

    Set xml            = CreateObject("Msxml2.DOMDocument.6.0")
    Set node           = xml.CreateElement("base64")
    node.DataType      = "bin.base64"
    node.NodeTypedValue = bytes
    EncodeBase64Utf8   = Replace(Replace(node.Text, vbCr, ""), vbLf, "")
End Function

Sub ReleaseComObject(ByRef obj)
    Set obj = Nothing
End Sub
