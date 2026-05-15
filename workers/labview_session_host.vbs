Option Explicit

Const REQUEST_SUFFIX_TYPE = "_type"
Const REQUEST_SUFFIX_VAL  = "_val"
Const REQUEST_SUFFIX_B64  = "_b64"
Const REQUEST_PART_TYPE   = "type"
Const REQUEST_PART_VAL    = "val"

Const RESPONSE_BEGIN = "__LABVIEW_RESPONSE_BEGIN__"
Const RESPONSE_END   = "__LABVIEW_RESPONSE_END__"

Const DEFAULT_TIMEOUT_SECONDS = 45
Const RETRY_INTERVAL_MS = 750
Const WAIT_FOR_REUSE_MS = 2500
Const PRINT_FORMAT_COMPLETE = 4
Const HTML_IMAGE_FORMAT_PNG = 0
Const FP_STATE_VISIBLE = 1
Const FP_STATE_HIDDEN = 3
Const WIA_FORMAT_PNG = "{B96B3CAF-0728-11D3-9D7B-0000F81EF32E}"
Const BMP_INFO_HEADER_SIZE = 40
Const BMP_PIXEL_DATA_OFFSET = 54
Const BMP_PIXELS_PER_METER = 2835

Dim targetExe
Dim expectedDirectory
Dim expectedVersion

Dim app
Dim attempts
Dim selection
Dim reason
Dim connectedVersion
Dim connectedDirectory

Dim writableMeta

targetExe = GetNamedArg("targetExe", "")
expectedDirectory = GetNamedArg("expectedDirectory", "")
expectedVersion = GetNamedArg("expectedVersion", "")

Set app = Nothing
Set writableMeta = CreateObject("Scripting.Dictionary")
writableMeta.CompareMode = 1
writableMeta.Add "Description", "String|vi"
writableMeta.Add "EditMode", "Boolean|vi"
writableMeta.Add "RunOnOpen", "Boolean|vi"
writableMeta.Add "PreferredExecSystem", "Number|vi"
writableMeta.Add "ShowFPOnCall", "Boolean|vi"
writableMeta.Add "ShowFPOnLoad", "Boolean|vi"
writableMeta.Add "AllowDebugging", "Boolean|vi"
writableMeta.Add "IsReentrant", "Boolean|vi"
writableMeta.Add "ReentrancyType", "Number|vi"
writableMeta.Add "CloseFPAfterCall", "Boolean|vi"
writableMeta.Add "FPWinTitle", "String|vi"
writableMeta.Add "FPRunTransparently", "Boolean|vi"
writableMeta.Add "FPTransparency", "Number|vi"
writableMeta.Add "FPResizable", "Boolean|vi"
writableMeta.Add "FPMinimizable", "Boolean|vi"
writableMeta.Add "FPShowMenuBar", "Boolean|vi"
writableMeta.Add "TBVisible", "Boolean|vi"
writableMeta.Add "TBShowRunButton", "Boolean|vi"
writableMeta.Add "TBShowAbortButton", "Boolean|vi"
writableMeta.Add "FPWinIsFrontMost", "Boolean|vi"
writableMeta.Add "FPWinClosable", "Boolean|vi"

On Error Resume Next
Main
If Err.Number <> 0 Then
    ResetRequestState
    reason = Err.Description
    WriteFramedResponse BuildFailureResponse("")
    WScript.Quit 3
End If
On Error GoTo 0

Sub Main()
    Dim request

    Do
        Set request = ReadRequest()
        If request Is Nothing Then
            Exit Do
        End If
        If LCase(GetRequestValue(request, "command", "")) = "shutdown" Then
            Exit Do
        End If
        HandleRequest request
    Loop

    ReleaseComObject app
End Sub

Function ReadRequest()
    Dim request
    Dim line
    Dim eqPos
    Dim key
    Dim value

    Set request = CreateObject("Scripting.Dictionary")
    request.CompareMode = 1

    Do
        If WScript.StdIn.AtEndOfStream Then
            Exit Do
        End If

        line = WScript.StdIn.ReadLine
        If Len(line) = 0 Then
            Exit Do
        End If

        eqPos = InStr(line, "=")
        If eqPos > 0 Then
            key = LCase(Left(line, eqPos - 1))
            value = Mid(line, eqPos + 1)
            If Len(key) > Len(REQUEST_SUFFIX_B64) And Right(key, Len(REQUEST_SUFFIX_B64)) = REQUEST_SUFFIX_B64 Then
                request.Item(Left(key, Len(key) - Len(REQUEST_SUFFIX_B64))) = DecodeBase64Utf8(value)
            Else
                request.Item(key) = value
            End If
        End If
    Loop

    If request.Count = 0 Then
        Set ReadRequest = Nothing
    Else
        Set ReadRequest = request
    End If
End Function

Sub HandleRequest(ByRef request)
    Dim command
    Dim timeoutSeconds

    ResetRequestState
    command = LCase(GetRequestValue(request, "command", ""))
    timeoutSeconds = ParseLong(GetRequestValue(request, "timeoutseconds", CStr(DEFAULT_TIMEOUT_SECONDS)), DEFAULT_TIMEOUT_SECONDS)

    On Error Resume Next
    Select Case command
        Case "probe-session"
            HandleProbeSession request
        Case "read-props"
            HandleReadProps request, timeoutSeconds
        Case "write-props"
            HandleWriteProps request, timeoutSeconds
        Case "export-panels"
            HandleExportPanels request, timeoutSeconds
        Case Else
            Err.Raise vbObjectError + 1000, , "Unknown command: " & command
    End Select

    If Err.Number <> 0 Then
        reason = Err.Description
        WriteFramedResponse BuildFailureResponse(command)
        Err.Clear
    End If
    On Error GoTo 0
End Sub

Sub HandleProbeSession(ByRef request)
    Dim mismatchMessage

    mismatchMessage = ""

    If HasReusableSessionApp() Then
        WriteFramedResponse BuildBaseResponse(True)
    ElseIf TryReuseRunningLabVIEW(mismatchMessage) Then
        WriteFramedResponse BuildBaseResponse(True)
    Else
        If Len(mismatchMessage) > 0 Then
            selection = "failed-to-match-target-labview-application"
            reason = mismatchMessage
        Else
            selection = "no-reusable-session-labview-application"
            reason = "No reusable or already running LabVIEW session is available."
        End If
        WriteFramedResponse BuildBaseResponse(False)
    End If
End Sub

Sub HandleReadProps(ByRef request, ByVal timeoutSeconds)
    Dim viPath
    Dim viRef
    Dim responseText

    viPath = GetRequestValue(request, "vipath", "")
    If Len(viPath) = 0 Then
        Err.Raise vbObjectError + 101, , "Missing viPath request field."
    End If
    If Not FileExists(viPath) Then
        Err.Raise vbObjectError + 102, , "VI file not found: " & viPath
    End If

    EnsureLabVIEWConnected timeoutSeconds

    Err.Clear
    Set viRef = app.GetVIReference(viPath)
    If Err.Number <> 0 Then
        Err.Raise vbObjectError + 103, , "GetVIReference failed: " & Err.Description
    End If

    responseText = BuildBaseResponse(True)
    responseText = responseText & BuildReadPropsLines(viRef)

    ReleaseComObject viRef
    WriteFramedResponse responseText
End Sub

Sub HandleWriteProps(ByRef request, ByVal timeoutSeconds)
    Dim viPath
    Dim requestPath
    Dim saveAfterWrite
    Dim updates
    Dim viRef
    Dim responseText
    Dim saveOk
    Dim saveError

    viPath = GetRequestValue(request, "vipath", "")
    requestPath = GetRequestValue(request, "requestpath", "")
    saveAfterWrite = (GetRequestValue(request, "save", "1") <> "0")

    If Len(viPath) = 0 Then
        Err.Raise vbObjectError + 111, , "Missing viPath request field."
    End If
    If Len(requestPath) = 0 Then
        Err.Raise vbObjectError + 112, , "Missing requestPath request field."
    End If
    If Not FileExists(viPath) Then
        Err.Raise vbObjectError + 113, , "VI file not found: " & viPath
    End If
    If Not FileExists(requestPath) Then
        Err.Raise vbObjectError + 114, , "Request file not found: " & requestPath
    End If

    Set updates = ParseWriteRequestFile(requestPath)
    EnsureLabVIEWConnected timeoutSeconds

    Err.Clear
    Set viRef = app.GetVIReference(viPath)
    If Err.Number <> 0 Then
        Err.Raise vbObjectError + 115, , "GetVIReference failed: " & Err.Description
    End If

    responseText = BuildBaseResponse(True)
    responseText = responseText & BuildWritePropsLines(viRef, updates)

    saveOk = True
    saveError = ""
    If saveAfterWrite Then
        On Error Resume Next
        Err.Clear
        viRef.SaveInstrument
        If Err.Number <> 0 Then
            saveOk = False
            saveError = "SaveInstrument failed: " & Err.Description
            Err.Clear
        End If
        On Error GoTo 0
    End If

    If saveOk Then
        AppendLine responseText, "saved=1"
    Else
        AppendLine responseText, "saved=0"
        AppendLine responseText, "save_errmsg_b64=" & EncodeBase64Utf8(saveError)
    End If

    ReleaseComObject viRef
    WriteFramedResponse responseText
End Sub

Sub HandleExportPanels(ByRef request, ByVal timeoutSeconds)
    Dim viPath
    Dim fpOutputPath
    Dim bdOutputPath
    Dim viRef
    Dim responseText
    Dim exportedOutputPath
    Dim exportedFpOutputPath
    Dim exportedBdOutputPath

    viPath = GetRequestValue(request, "vipath", "")
    fpOutputPath = GetRequestValue(request, "fpoutputpath", "")
    bdOutputPath = GetRequestValue(request, "bdoutputpath", "")

    If Len(viPath) = 0 Then
        Err.Raise vbObjectError + 121, , "Missing viPath request field."
    End If
    If Not FileExists(viPath) Then
        Err.Raise vbObjectError + 122, , "VI file not found: " & viPath
    End If
    If Len(fpOutputPath) = 0 And Len(bdOutputPath) = 0 Then
        Err.Raise vbObjectError + 123, , "Missing fpOutputPath/bdOutputPath request field."
    End If

    EnsureLabVIEWConnected timeoutSeconds

    Err.Clear
    Set viRef = app.GetVIReference(viPath)
    If Err.Number <> 0 Then
        Err.Raise vbObjectError + 124, , "GetVIReference failed: " & Err.Description
    End If

    ExportPanelImages viRef, fpOutputPath, bdOutputPath, exportedOutputPath, exportedFpOutputPath, exportedBdOutputPath

    responseText = BuildBaseResponse(True)
    AppendLine responseText, "output_path_b64=" & EncodeBase64Utf8(exportedOutputPath)
    AppendLine responseText, "fp_output_path_b64=" & EncodeBase64Utf8(exportedFpOutputPath)
    AppendLine responseText, "bd_output_path_b64=" & EncodeBase64Utf8(exportedBdOutputPath)

    ReleaseComObject viRef
    WriteFramedResponse responseText
End Sub

Sub ResetRequestState()
    attempts = 0
    selection = ""
    reason = ""
    connectedVersion = ""
    connectedDirectory = ""
End Sub

Sub EnsureLabVIEWConnected(ByVal timeoutSeconds)
    Dim deadline
    Dim createError
    Dim lastMismatch
    Dim appDir
    Dim appVer

    createError = ""
    lastMismatch = ""

    If HasReusableSessionApp() Then
        Exit Sub
    End If
    If TryReuseRunningLabVIEW(lastMismatch) Then
        Exit Sub
    End If

    deadline = DateAdd("s", timeoutSeconds, Now)

    Do While Now < deadline
        attempts = attempts + 1

        If ShouldActivateTargetInstance(attempts) Then
            StartTargetLabVIEW targetExe
            If WaitForReusableTargetInstance(WAIT_FOR_REUSE_MS, lastMismatch) Then
                Exit Sub
            End If
        End If

        On Error Resume Next
        Set app = Nothing
        Err.Clear
        If Len(targetExe) > 0 And Not CanUseGenericComActivationForTarget(targetExe) Then
            createError = "Timed out waiting for the requested LabVIEW target to register for COM reuse."
        Else
            Set app = CreateObject("LabVIEW.Application")
            If Err.Number <> 0 Then
                createError = "CreateObject failed: " & Err.Description
                Err.Clear
            Else
                appDir = SafeGetAppDirectory(app)
                appVer = SafeGetAppVersion(app)
                connectedDirectory = appDir
                connectedVersion = appVer
                If AppMatches(appDir, appVer) Then
                    If Len(targetExe) > 0 Then
                        selection = "created-target-labview-application"
                        reason = "Created or attached a LabVIEW automation instance for the requested installation."
                    Else
                        selection = "created-default-labview-application"
                        reason = "Created a LabVIEW automation instance because no reusable session was available."
                    End If
                    On Error GoTo 0
                    Exit Sub
                End If

                lastMismatch = "Connected to " & DescribeApp(appDir, appVer) & ", which does not match the requested target."
                ReleaseComObject app
            End If
        End If
        On Error GoTo 0

        WScript.Sleep RETRY_INTERVAL_MS
    Loop

    If Len(lastMismatch) > 0 Then
        selection = "failed-to-match-target-labview-application"
        Err.Raise vbObjectError + 201, , lastMismatch
    End If

    selection = "failed-to-create-labview-application"
    If Len(createError) = 0 Then
        createError = "Connection timed out."
    End If
    Err.Raise vbObjectError + 202, , createError
End Sub

Function HasReusableSessionApp()
    Dim appDir
    Dim appVer

    HasReusableSessionApp = False

    If (app Is Nothing) Then
        Exit Function
    End If

    appDir = SafeGetAppDirectory(app)
    appVer = SafeGetAppVersion(app)
    If Len(appDir) = 0 And Len(appVer) = 0 Then
        ReleaseComObject app
        Exit Function
    End If

    connectedDirectory = appDir
    connectedVersion = appVer
    If AppMatches(appDir, appVer) Then
        If Len(targetExe) > 0 Or Len(expectedDirectory) > 0 Or Len(expectedVersion) > 0 Then
            selection = "reused-session-labview-application"
            reason = "Reused the persistent LabVIEW session for the requested target."
        Else
            selection = "reused-session-default-labview-application"
            reason = "Reused the persistent default LabVIEW session."
        End If
        HasReusableSessionApp = True
    Else
        ReleaseComObject app
    End If
End Function

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
    connectedVersion = appVer

    If AppMatches(appDir, appVer) Then
        Set app = candidate
        If Len(targetExe) > 0 Or Len(expectedDirectory) > 0 Or Len(expectedVersion) > 0 Then
            selection = "reused-running-labview-application"
            reason = "Attached to an already running LabVIEW instance matching the requested target."
        Else
            selection = "reused-default-labview-application"
            reason = "Attached to the running default LabVIEW instance."
        End If
        TryReuseRunningLabVIEW = True
    Else
        mismatchMessage = "Connected to " & DescribeApp(appDir, appVer) & ", which does not match the requested target."
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

Function AppMatches(ByVal appDir, ByVal appVer)
    AppMatches = False
    If Len(expectedDirectory) > 0 Then
        If NormalizePath(appDir) = NormalizePath(expectedDirectory) Then
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

Sub StartTargetLabVIEW(ByVal exePath)
    Dim shell
    If Len(exePath) = 0 Then Exit Sub

    On Error Resume Next
    Set shell = CreateObject("WScript.Shell")
    If Err.Number = 0 Then
        shell.Run QuoteArg(exePath) & " /Automation", 0, False
        Err.Clear
    End If
    On Error GoTo 0
End Sub

Function BuildBaseResponse(ByVal ok)
    Dim responseText

    responseText = ""
    AppendLine responseText, "ok=" & BoolToFlag(ok)
    AppendLine responseText, "selection=" & SafeAscii(selection)
    AppendLine responseText, "reason_b64=" & EncodeBase64Utf8(reason)
    AppendLine responseText, "connected_version_b64=" & EncodeBase64Utf8(connectedVersion)
    AppendLine responseText, "connected_directory_b64=" & EncodeBase64Utf8(connectedDirectory)
    AppendLine responseText, "attempts=" & CStr(attempts)
    BuildBaseResponse = responseText
End Function

Function BuildFailureResponse(ByVal command)
    Dim responseText

    responseText = BuildBaseResponse(False)
    If command = "write-props" Then
        AppendLine responseText, "saved=0"
    ElseIf command = "export-panels" Then
        AppendLine responseText, "output_path_b64="
        AppendLine responseText, "fp_output_path_b64="
        AppendLine responseText, "bd_output_path_b64="
    End If
    BuildFailureResponse = responseText
End Function

Function BuildReadPropsLines(ByRef viRef)
    Dim responseText
    Dim val
    Dim ok
    Dim errMsg

    responseText = ""
    On Error Resume Next

    val = "" : Err.Clear
    val = CStr(viRef.Name)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    AppendPropLine responseText, "Name", "String", ok, val, errMsg

    val = "" : Err.Clear
    val = CStr(viRef.Path)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    AppendPropLine responseText, "Path", "String", ok, val, errMsg

    val = "" : Err.Clear
    val = ReadOwningAppSummary(viRef)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    AppendPropLine responseText, "OwningApp", "String", ok, val, errMsg

    val = "" : Err.Clear
    val = CStr(viRef.VIType)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    AppendPropLine responseText, "VIType", "Number", ok, val, errMsg

    val = "" : Err.Clear
    val = CStr(viRef.Description)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    AppendPropLine responseText, "Description", "String", ok, val, errMsg

    val = "" : Err.Clear
    val = CStr(viRef.RevisionNumber)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    AppendPropLine responseText, "RevisionNumber", "String", ok, val, errMsg

    val = "" : Err.Clear
    val = CStr(viRef.EditMode)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    AppendPropLine responseText, "EditMode", "Boolean", ok, val, errMsg

    val = "" : Err.Clear
    val = CStr(viRef.ExecState)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    AppendPropLine responseText, "ExecState", "Number", ok, val, errMsg

    val = "" : Err.Clear
    val = CStr(viRef.RunOnOpen)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    AppendPropLine responseText, "RunOnOpen", "Boolean", ok, val, errMsg

    val = "" : Err.Clear
    val = CStr(viRef.PreferredExecSystem)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    AppendPropLine responseText, "PreferredExecSystem", "Number", ok, val, errMsg

    val = "" : Err.Clear
    val = CStr(viRef.ShowFPOnCall)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    AppendPropLine responseText, "ShowFPOnCall", "Boolean", ok, val, errMsg

    val = "" : Err.Clear
    val = CStr(viRef.ShowFPOnLoad)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    AppendPropLine responseText, "ShowFPOnLoad", "Boolean", ok, val, errMsg

    val = "" : Err.Clear
    val = CStr(viRef.AllowDebugging)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    AppendPropLine responseText, "AllowDebugging", "Boolean", ok, val, errMsg

    val = "" : Err.Clear
    val = CStr(viRef.IsReentrant)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    AppendPropLine responseText, "IsReentrant", "Boolean", ok, val, errMsg

    val = "" : Err.Clear
    val = CStr(viRef.ReentrancyType)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    AppendPropLine responseText, "ReentrancyType", "Number", ok, val, errMsg

    val = "" : Err.Clear
    val = CStr(viRef.CloseFPAfterCall)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    AppendPropLine responseText, "CloseFPAfterCall", "Boolean", ok, val, errMsg

    val = "" : Err.Clear
    val = CStr(viRef.FPState)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    AppendPropLine responseText, "FPState", "Number", ok, val, errMsg

    val = "" : Err.Clear
    val = FormatBoundsValue(viRef.FPWinBounds)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    AppendPropLine responseText, "FPWinBounds", "String", ok, val, errMsg

    val = "" : Err.Clear
    val = CStr(viRef.FPWinTitle)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    AppendPropLine responseText, "FPWinTitle", "String", ok, val, errMsg

    val = "" : Err.Clear
    val = CStr(viRef.FPRunTransparently)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    AppendPropLine responseText, "FPRunTransparently", "Boolean", ok, val, errMsg

    val = "" : Err.Clear
    val = CStr(viRef.FPTransparency)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    AppendPropLine responseText, "FPTransparency", "Number", ok, val, errMsg

    val = "" : Err.Clear
    val = CStr(viRef.FPResizable)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    AppendPropLine responseText, "FPResizable", "Boolean", ok, val, errMsg

    val = "" : Err.Clear
    val = CStr(viRef.FPMinimizeable)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    AppendPropLine responseText, "FPMinimizable", "Boolean", ok, val, errMsg

    val = "" : Err.Clear
    val = CStr(viRef.FPShowMenuBar)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    AppendPropLine responseText, "FPShowMenuBar", "Boolean", ok, val, errMsg

    val = "" : Err.Clear
    val = CStr(viRef.TBVisible)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    AppendPropLine responseText, "TBVisible", "Boolean", ok, val, errMsg

    val = "" : Err.Clear
    val = CStr(viRef.TBShowRunButton)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    AppendPropLine responseText, "TBShowRunButton", "Boolean", ok, val, errMsg

    val = "" : Err.Clear
    val = CStr(viRef.TBShowAbortButton)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    AppendPropLine responseText, "TBShowAbortButton", "Boolean", ok, val, errMsg

    val = "" : Err.Clear
    val = CStr(viRef.FPWinClosable)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    AppendPropLine responseText, "FPWinClosable", "Boolean", ok, val, errMsg

    val = "" : Err.Clear
    val = CStr(viRef.BDSize)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    AppendPropLine responseText, "BDSize", "Number", ok, val, errMsg

    val = "" : Err.Clear
    val = CStr(viRef.FPSize)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    AppendPropLine responseText, "FPSize", "Number", ok, val, errMsg

    val = "" : Err.Clear
    val = CStr(viRef.CodeSize)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    AppendPropLine responseText, "CodeSize", "Number", ok, val, errMsg

    val = "" : Err.Clear
    val = CStr(viRef.DataSize)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    AppendPropLine responseText, "DataSize", "Number", ok, val, errMsg

    On Error GoTo 0
    BuildReadPropsLines = responseText
End Function

Function BuildWritePropsLines(ByRef viRef, ByRef updates)
    Dim responseText
    Dim keys
    Dim index
    Dim propName
    Dim metadata
    Dim separator
    Dim propType
    Dim payload
    Dim payloadSeparator
    Dim requestedType
    Dim requestedValueB64
    Dim newVal
    Dim ok
    Dim errMsg

    responseText = ""
    keys = updates.Keys

    For index = 0 To UBound(keys)
        propName = keys(index)
        If Not writableMeta.Exists(propName) Then
            AppendPropLine responseText, propName, "Unknown", False, "", "Property is not writable or unknown."
        Else
            metadata = writableMeta.Item(propName)
            separator = InStr(metadata, "|")
            propType = Left(metadata, separator - 1)

            payload = updates.Item(propName)
            payloadSeparator = InStr(payload, "|")
            If payloadSeparator > 0 Then
                requestedType = Left(payload, payloadSeparator - 1)
                requestedValueB64 = Mid(payload, payloadSeparator + 1)
            Else
                requestedType = ""
                requestedValueB64 = ""
            End If

            If Len(requestedType) > 0 And StrComp(requestedType, propType, 1) <> 0 Then
                AppendPropLine responseText, propName, propType, False, "", _
                    "Type mismatch: requested " & requestedType & ", expected " & propType
            Else
                newVal = DecodeBase64Utf8(requestedValueB64)
                On Error Resume Next
                Err.Clear
                AssignProp viRef, propName, newVal
                ok = (Err.Number = 0)
                errMsg = Err.Description
                Err.Clear
                On Error GoTo 0

                If ok Then
                    AppendPropLine responseText, propName, propType, True, ReadBackVi(viRef, propName), ""
                Else
                    AppendPropLine responseText, propName, propType, False, "", errMsg
                End If
            End If
        End If
    Next

    BuildWritePropsLines = responseText
End Function

Sub AppendPropLine(ByRef responseText, ByVal key, ByVal propType, ByVal ok, ByVal val, ByVal errMsg)
    AppendLine responseText, "prop_" & key & "_type=" & propType
    If ok Then
        AppendLine responseText, "prop_" & key & "_ok=1"
        AppendLine responseText, "prop_" & key & "_val=" & EncodeBase64Utf8(val)
    Else
        AppendLine responseText, "prop_" & key & "_ok=0"
        AppendLine responseText, "prop_" & key & "_errmsg=" & EncodeBase64Utf8(errMsg)
    End If
End Sub

Sub AssignProp(ByRef viRef, ByVal propName, ByVal newVal)
    Select Case propName
        Case "Description"         : viRef.Description = CStr(newVal)
        Case "EditMode"            : viRef.EditMode = CoerceBool(newVal)
        Case "RunOnOpen"           : viRef.RunOnOpen = CoerceBool(newVal)
        Case "PreferredExecSystem" : viRef.PreferredExecSystem = CLng(newVal)
        Case "ShowFPOnCall"        : viRef.ShowFPOnCall = CoerceBool(newVal)
        Case "ShowFPOnLoad"        : viRef.ShowFPOnLoad = CoerceBool(newVal)
        Case "AllowDebugging"      : viRef.AllowDebugging = CoerceBool(newVal)
        Case "IsReentrant"         : viRef.IsReentrant = CoerceBool(newVal)
        Case "ReentrancyType"      : viRef.ReentrancyType = CLng(newVal)
        Case "CloseFPAfterCall"    : viRef.CloseFPAfterCall = CoerceBool(newVal)
        Case "FPWinTitle"          : viRef.FPWinTitle = CStr(newVal)
        Case "FPRunTransparently"  : viRef.FPRunTransparently = CoerceBool(newVal)
        Case "FPTransparency"      : viRef.FPTransparency = CLng(newVal)
        Case "FPResizable"         : viRef.FPResizable = CoerceBool(newVal)
        Case "FPMinimizable"       : viRef.FPMinimizeable = CoerceBool(newVal)
        Case "FPShowMenuBar"       : viRef.FPShowMenuBar = CoerceBool(newVal)
        Case "TBVisible"           : viRef.TBVisible = CoerceBool(newVal)
        Case "TBShowRunButton"     : viRef.TBShowRunButton = CoerceBool(newVal)
        Case "TBShowAbortButton"   : viRef.TBShowAbortButton = CoerceBool(newVal)
        Case "FPWinIsFrontMost"    : viRef.FPWinIsFrontMost = CoerceBool(newVal)
        Case "FPWinClosable"       : viRef.FPWinClosable = CoerceBool(newVal)
        Case Else
            Err.Raise vbObjectError + 301, , "Unsupported property: " & propName
    End Select
End Sub

Function ReadBackVi(ByRef viRef, ByVal propName)
    Dim val

    val = ""
    On Error Resume Next
    Select Case propName
        Case "Description"         : val = CStr(viRef.Description)
        Case "RevisionNumber"      : val = CStr(viRef.RevisionNumber)
        Case "EditMode"            : val = CStr(viRef.EditMode)
        Case "RunOnOpen"           : val = CStr(viRef.RunOnOpen)
        Case "PreferredExecSystem" : val = CStr(viRef.PreferredExecSystem)
        Case "ShowFPOnCall"        : val = CStr(viRef.ShowFPOnCall)
        Case "ShowFPOnLoad"        : val = CStr(viRef.ShowFPOnLoad)
        Case "AllowDebugging"      : val = CStr(viRef.AllowDebugging)
        Case "IsReentrant"         : val = CStr(viRef.IsReentrant)
        Case "ReentrancyType"      : val = CStr(viRef.ReentrancyType)
        Case "CloseFPAfterCall"    : val = CStr(viRef.CloseFPAfterCall)
        Case "FPState"             : val = CStr(viRef.FPState)
        Case "FPWinBounds"         : val = FormatBoundsValue(viRef.FPWinBounds)
        Case "FPWinTitle"          : val = CStr(viRef.FPWinTitle)
        Case "FPRunTransparently"  : val = CStr(viRef.FPRunTransparently)
        Case "FPTransparency"      : val = CStr(viRef.FPTransparency)
        Case "FPResizable"         : val = CStr(viRef.FPResizable)
        Case "FPMinimizable"      : val = CStr(viRef.FPMinimizeable)
        Case "FPShowMenuBar"       : val = CStr(viRef.FPShowMenuBar)
        Case "TBVisible"           : val = CStr(viRef.TBVisible)
        Case "TBShowRunButton"     : val = CStr(viRef.TBShowRunButton)
        Case "TBShowAbortButton"   : val = CStr(viRef.TBShowAbortButton)
        Case "FPWinIsFrontMost"    : val = ""
        Case "FPWinClosable"       : val = CStr(viRef.FPWinClosable)
    End Select
    If Err.Number <> 0 Then
        val = ""
        Err.Clear
    End If
    On Error GoTo 0
    ReadBackVi = val
End Function

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

Function CoerceBool(ByVal value)
    Dim normalized

    normalized = LCase(Trim(CStr(value)))
    If normalized = "1" Or normalized = "true" Or normalized = "yes" Or normalized = "-1" Then
        CoerceBool = True
    ElseIf normalized = "0" Or normalized = "false" Or normalized = "no" Or normalized = "" Then
        CoerceBool = False
    Else
        CoerceBool = CBool(value)
    End If
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

Sub ExportPanelImages(ByRef viRef, ByVal fpFinalOutputPath, ByVal bdFinalOutputPath, ByRef exportedOutputPath, ByRef exportedFpOutputPath, ByRef exportedBdOutputPath)
    Dim fso
    Dim tempRoot
    Dim exportRoot
    Dim htmlPath
    Dim imageDir
    Dim sourcePath
    Dim htmlExported
    Dim exportError

    exportedOutputPath = ""
    exportedFpOutputPath = ""
    exportedBdOutputPath = ""
    htmlExported = False
    exportError = ""

    Set fso = CreateObject("Scripting.FileSystemObject")
    tempRoot = GetTempFolder()
    exportRoot = BuildUniqueTempDir(tempRoot, "lv-html-export-")
    htmlPath = fso.BuildPath(exportRoot, "export.html")
    imageDir = fso.BuildPath(exportRoot, "images")

    If Not fso.FolderExists(exportRoot) Then fso.CreateFolder exportRoot
    If Not fso.FolderExists(imageDir) Then fso.CreateFolder imageDir

    If Len(fpFinalOutputPath) > 0 Then
        If Not TrySaveFrontPanelImage(viRef, fpFinalOutputPath, exportRoot, htmlPath, imageDir, htmlExported, exportError) Then
            CleanupFolder exportRoot
            Err.Raise vbObjectError + 402, , exportError
        End If
        exportedFpOutputPath = fpFinalOutputPath
        exportedOutputPath = fpFinalOutputPath
    End If

    If Len(bdFinalOutputPath) > 0 Then
        If Not EnsureHtmlExport(viRef, htmlPath, imageDir, htmlExported, exportError) Then
            CleanupFolder exportRoot
            Err.Raise vbObjectError + 401, , exportError
        End If
        sourcePath = FindExportedImage(imageDir, "d.png")
        If Len(sourcePath) = 0 Then
            CleanupFolder exportRoot
            Err.Raise vbObjectError + 403, , "LabVIEW HTML export did not produce *d.png."
        End If
        EnsureParentFolder bdFinalOutputPath
        fso.CopyFile sourcePath, bdFinalOutputPath, True
        exportedBdOutputPath = bdFinalOutputPath
        If Len(exportedOutputPath) = 0 Then
            exportedOutputPath = bdFinalOutputPath
        End If
    End If

    CleanupFolder exportRoot
End Sub

Function TrySaveFrontPanelImage(ByRef viRef, ByVal finalOutputPath, ByVal exportRoot, ByVal htmlPath, ByVal imageDir, ByRef htmlExported, ByRef errorMessage)
    Dim fso
    Dim sourcePath
    Dim exportError
    Dim htmlErrorMessage

    TrySaveFrontPanelImage = False
    errorMessage = ""
    exportError = ""
    htmlErrorMessage = ""
    Set fso = CreateObject("Scripting.FileSystemObject")

    If Not EnsureHtmlExport(viRef, htmlPath, imageDir, htmlExported, exportError) Then
        htmlErrorMessage = exportError
    Else
        sourcePath = FindExportedImage(imageDir, "p.png")
        If Len(sourcePath) > 0 Then
            If Not TryNormalizeFrontPanelPng(sourcePath, finalOutputPath, errorMessage) Then
                htmlErrorMessage = "Front panel PNG normalization failed: " & errorMessage
                errorMessage = ""
            Else
                TrySaveFrontPanelImage = True
                Exit Function
            End If
        End If

        htmlErrorMessage = "LabVIEW HTML export did not produce *p.png."
    End If

    If TryCaptureFrontPanelPng(viRef, finalOutputPath, exportRoot, errorMessage) Then
        TrySaveFrontPanelImage = True
        Exit Function
    End If

    If Len(errorMessage) = 0 Then
        errorMessage = htmlErrorMessage
    ElseIf Len(htmlErrorMessage) > 0 Then
        errorMessage = htmlErrorMessage & " Fallback failed: " & errorMessage
    End If
    Exit Function
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
    If Not TryNormalizeFrontPanelPng(outputPath, outputPath, errorMessage) Then
        CloseFrontPanelSafe viRef
        Exit Function
    End If
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
    DeleteFileIfExists scriptPath

    If exec.ExitCode <> 0 Then
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
        errorMessage = "PowerShell RGB conversion exited successfully but did not create output file."
        If Len(stderrText) > 0 Then
            errorMessage = errorMessage & " stderr=" & stderrText
        End If
        If Len(stdoutText) > 0 Then
            errorMessage = errorMessage & " stdout=" & stdoutText
        End If
        Exit Function
    End If

    TryConvertRawRgbToPng = True
End Function

Function TryNormalizeFrontPanelPng(ByVal sourcePath, ByVal outputPath, ByRef errorMessage)
    Dim shell
    Dim exec
    Dim command
    Dim scriptPath
    Dim stderrText
    Dim stdoutText

    TryNormalizeFrontPanelPng = False
    errorMessage = ""

    If Not FileExists(sourcePath) Then
        errorMessage = "Front panel PNG not found: " & sourcePath
        Exit Function
    End If

    scriptPath = BuildUniqueTempFilePath(GetTempFolder(), "labview-crop-front-panel-", ".ps1")
    If Not TryWriteAsciiTextFile(scriptPath, BuildFrontPanelCropPowerShellScript(), errorMessage) Then
        Exit Function
    End If

    command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -Command " _
        & QuoteArg("& " & QuotePowerShellLiteral(scriptPath) _
        & " -SourcePath " & QuotePowerShellLiteral(sourcePath) _
        & " -OutputPath " & QuotePowerShellLiteral(outputPath))

    On Error Resume Next
    Set shell = CreateObject("WScript.Shell")
    Set exec = shell.Exec(command)
    If Err.Number <> 0 Then
        errorMessage = "Failed to start PowerShell front panel normalization: " & Err.Description
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
    DeleteFileIfExists scriptPath

    If exec.ExitCode <> 0 Then
        errorMessage = stderrText
        If Len(errorMessage) = 0 Then
            errorMessage = stdoutText
        End If
        If Len(errorMessage) = 0 Then
            errorMessage = "PowerShell front panel normalization failed with exit code " & CStr(exec.ExitCode) & "."
        End If
        Exit Function
    End If

    If Not FileExists(outputPath) Then
        errorMessage = "PowerShell front panel normalization exited successfully but did not create output file."
        If Len(stderrText) > 0 Then
            errorMessage = errorMessage & " stderr=" & stderrText
        End If
        If Len(stdoutText) > 0 Then
            errorMessage = errorMessage & " stdout=" & stdoutText
        End If
        Exit Function
    End If

    TryNormalizeFrontPanelPng = True
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

Function BuildFrontPanelCropPowerShellScript()
    Dim lines(61)

    lines(0) = "param([string]$SourcePath, [string]$OutputPath)"
    lines(1) = "$ErrorActionPreference = 'Stop'"
    lines(2) = "Add-Type -AssemblyName System.Drawing"
    lines(3) = "function Save-NormalizedBitmap {"
    lines(4) = "  param([System.Drawing.Bitmap]$BitmapToSave, [string]$DestinationPath)"
    lines(5) = "  $directory = Split-Path -Parent $DestinationPath; if ($directory) { [System.IO.Directory]::CreateDirectory($directory) | Out-Null }"
    lines(6) = "  $tempPath = Join-Path ([System.IO.Path]::GetTempPath()) ('labview-fp-crop-' + [System.Guid]::NewGuid().ToString('N') + '.png')"
    lines(7) = "  try {"
    lines(8) = "    if (Test-Path $tempPath) { Remove-Item $tempPath -Force }"
    lines(9) = "    $BitmapToSave.Save($tempPath, [System.Drawing.Imaging.ImageFormat]::Png)"
    lines(10) = "    if (Test-Path $DestinationPath) { Remove-Item $DestinationPath -Force }"
    lines(11) = "    [System.IO.File]::Copy($tempPath, $DestinationPath, $true)"
    lines(12) = "  } finally {"
    lines(13) = "    if (Test-Path $tempPath) { Remove-Item $tempPath -Force }"
    lines(14) = "  }"
    lines(15) = "}"
    lines(16) = "function Test-IsBackgroundPixel {"
    lines(17) = "  param([System.Drawing.Color]$Pixel, [System.Drawing.Color]$Background, [int]$Tolerance)"
    lines(18) = "  if ($Pixel.A -lt 32) { return $true }"
    lines(19) = "  return [Math]::Abs([int]$Pixel.A - [int]$Background.A) -le $Tolerance -and [Math]::Abs([int]$Pixel.R - [int]$Background.R) -le $Tolerance -and [Math]::Abs([int]$Pixel.G - [int]$Background.G) -le $Tolerance -and [Math]::Abs([int]$Pixel.B - [int]$Background.B) -le $Tolerance"
    lines(20) = "}"
    lines(21) = "$sourceBitmap = [System.Drawing.Bitmap]::FromFile($SourcePath)"
    lines(22) = "try {"
    lines(23) = "  $sampleLongestSide = 512; $longestSide = [Math]::Max($sourceBitmap.Width, $sourceBitmap.Height)"
    lines(24) = "  $sampleScale = if ($longestSide -gt $sampleLongestSide) { $sampleLongestSide / [double]$longestSide } else { 1.0 }"
    lines(25) = "  $sampleWidth = [Math]::Max(1, [int][Math]::Round($sourceBitmap.Width * $sampleScale))"
    lines(26) = "  $sampleHeight = [Math]::Max(1, [int][Math]::Round($sourceBitmap.Height * $sampleScale))"
    lines(27) = "  $sampleBitmap = New-Object System.Drawing.Bitmap($sampleWidth, $sampleHeight, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)"
    lines(28) = "  try {"
    lines(29) = "    $graphics = [System.Drawing.Graphics]::FromImage($sampleBitmap)"
    lines(30) = "    try { $graphics.DrawImage($sourceBitmap, 0, 0, $sampleWidth, $sampleHeight) } finally { $graphics.Dispose() }"
    lines(31) = "    $borderWidth = [Math]::Max(1, [int][Math]::Round([Math]::Min($sampleWidth, $sampleHeight) * 0.08))"
    lines(32) = "    $bucketStep = 16; $buckets = @{}"
    lines(33) = "    for ($y = 0; $y -lt $sampleHeight; $y++) {"
    lines(34) = "      for ($x = 0; $x -lt $sampleWidth; $x++) {"
    lines(35) = "        if ($x -ge $borderWidth -and $y -ge $borderWidth -and $x -lt ($sampleWidth - $borderWidth) -and $y -lt ($sampleHeight - $borderWidth)) { continue }"
    lines(36) = "        $pixel = $sampleBitmap.GetPixel($x, $y); if ($pixel.A -lt 200) { continue }"
    lines(37) = "        $key = ('{0},{1},{2},{3}' -f ([int][Math]::Round($pixel.A / $bucketStep) * $bucketStep), ([int][Math]::Round($pixel.R / $bucketStep) * $bucketStep), ([int][Math]::Round($pixel.G / $bucketStep) * $bucketStep), ([int][Math]::Round($pixel.B / $bucketStep) * $bucketStep))"
    lines(38) = "        if (-not $buckets.ContainsKey($key)) { $buckets[$key] = [PSCustomObject]@{ Count = 0; A = 0; R = 0; G = 0; B = 0 } }"
    lines(39) = "        $bucket = $buckets[$key]; $bucket.Count += 1; $bucket.A += [int]$pixel.A; $bucket.R += [int]$pixel.R; $bucket.G += [int]$pixel.G; $bucket.B += [int]$pixel.B"
    lines(40) = "      }"
    lines(41) = "    }"
    lines(42) = "    if ($buckets.Count -eq 0) { Save-NormalizedBitmap $sourceBitmap $OutputPath; return }"
    lines(43) = "    $backgroundBucket = $buckets.Values | Sort-Object Count -Descending | Select-Object -First 1"
    lines(44) = "    $background = [System.Drawing.Color]::FromArgb([int][Math]::Round($backgroundBucket.A / $backgroundBucket.Count), [int][Math]::Round($backgroundBucket.R / $backgroundBucket.Count), [int][Math]::Round($backgroundBucket.G / $backgroundBucket.Count), [int][Math]::Round($backgroundBucket.B / $backgroundBucket.Count))"
    lines(45) = "    $tolerance = 18; $minX = $sampleWidth; $minY = $sampleHeight; $maxX = -1; $maxY = -1"
    lines(46) = "    for ($y = 0; $y -lt $sampleHeight; $y++) {"
    lines(47) = "      for ($x = 0; $x -lt $sampleWidth; $x++) {"
    lines(48) = "        if (Test-IsBackgroundPixel ($sampleBitmap.GetPixel($x, $y)) $background $tolerance) { continue }"
    lines(49) = "        if ($x -lt $minX) { $minX = $x }; if ($x -gt $maxX) { $maxX = $x }; if ($y -lt $minY) { $minY = $y }; if ($y -gt $maxY) { $maxY = $y }"
    lines(50) = "      }"
    lines(51) = "    }"
    lines(52) = "    if ($maxX -lt 0) { Save-NormalizedBitmap $sourceBitmap $OutputPath; return }"
    lines(53) = "    $scaleX = $sourceBitmap.Width / [double]$sampleWidth; $scaleY = $sourceBitmap.Height / [double]$sampleHeight; $padding = 12"
    lines(54) = "    $left = [Math]::Max(0, [int][Math]::Floor($minX * $scaleX) - $padding); $top = [Math]::Max(0, [int][Math]::Floor($minY * $scaleY) - $padding)"
    lines(55) = "    $right = [Math]::Min($sourceBitmap.Width - 1, [int][Math]::Ceiling(($maxX + 1) * $scaleX) - 1 + $padding); $bottom = [Math]::Min($sourceBitmap.Height - 1, [int][Math]::Ceiling(($maxY + 1) * $scaleY) - 1 + $padding)"
    lines(56) = "    if ($left -le 0 -and $top -le 0 -and $right -ge ($sourceBitmap.Width - 1) -and $bottom -ge ($sourceBitmap.Height - 1)) { Save-NormalizedBitmap $sourceBitmap $OutputPath; return }"
    lines(57) = "    $rect = New-Object System.Drawing.Rectangle $left, $top, ([Math]::Max(1, $right - $left + 1)), ([Math]::Max(1, $bottom - $top + 1))"
    lines(58) = "    $croppedBitmap = $sourceBitmap.Clone($rect, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)"
    lines(59) = "    try { Save-NormalizedBitmap $croppedBitmap $OutputPath } finally { $croppedBitmap.Dispose() }"
    lines(60) = "  } finally { $sampleBitmap.Dispose() }"
    lines(61) = "} finally { $sourceBitmap.Dispose() }"
    BuildFrontPanelCropPowerShellScript = Join(lines, vbCrLf)
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
    candidate = CreateGuidToken()
    BuildUniqueTempDir = fso.BuildPath(baseDir, prefix & candidate)
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

Function ParseWriteRequestFile(ByVal requestPath)
    Dim requestFile
    Dim line
    Dim eqPos
    Dim key
    Dim value
    Dim rest
    Dim propName
    Dim suffix
    Dim updates
    Dim existing
    Dim partType
    Dim partValue
    Dim separator

    Set updates = CreateObject("Scripting.Dictionary")
    updates.CompareMode = 1

    Set requestFile = CreateObject("Scripting.FileSystemObject").OpenTextFile(requestPath, 1, False, 0)
    Do Until requestFile.AtEndOfStream
        line = requestFile.ReadLine
        If Len(line) > 0 Then
            eqPos = InStr(line, "=")
            If eqPos > 0 Then
                key = Left(line, eqPos - 1)
                value = Mid(line, eqPos + 1)
                If Left(key, 4) = "set_" Then
                    rest = Mid(key, 5)
                    propName = ""
                    suffix = ""
                    If Len(rest) > Len(REQUEST_SUFFIX_TYPE) And LCase(Right(rest, Len(REQUEST_SUFFIX_TYPE))) = REQUEST_SUFFIX_TYPE Then
                        propName = Left(rest, Len(rest) - Len(REQUEST_SUFFIX_TYPE))
                        suffix = REQUEST_PART_TYPE
                    ElseIf Len(rest) > Len(REQUEST_SUFFIX_VAL) And LCase(Right(rest, Len(REQUEST_SUFFIX_VAL))) = REQUEST_SUFFIX_VAL Then
                        propName = Left(rest, Len(rest) - Len(REQUEST_SUFFIX_VAL))
                        suffix = REQUEST_PART_VAL
                    End If

                    If Len(propName) > 0 Then
                        partType = ""
                        partValue = ""
                        If updates.Exists(propName) Then
                            existing = updates.Item(propName)
                            separator = InStr(existing, "|")
                            If separator > 0 Then
                                partType = Left(existing, separator - 1)
                                partValue = Mid(existing, separator + 1)
                            End If
                        End If

                        If suffix = REQUEST_PART_TYPE Then
                            partType = value
                        ElseIf suffix = REQUEST_PART_VAL Then
                            partValue = value
                        End If
                        updates.Item(propName) = partType & "|" & partValue
                    End If
                End If
            End If
        End If
    Loop

    requestFile.Close
    Set ParseWriteRequestFile = updates
End Function

Sub WriteFramedResponse(ByVal responseText)
    WScript.StdOut.WriteLine RESPONSE_BEGIN
    If Len(responseText) > 0 Then
        WScript.StdOut.Write responseText
    End If
    WScript.StdOut.WriteLine RESPONSE_END
End Sub

Sub AppendLine(ByRef responseText, ByVal line)
    responseText = responseText & line & vbCrLf
End Sub

Function GetNamedArg(ByVal key, ByVal defaultValue)
    If WScript.Arguments.Named.Exists(key) Then
        GetNamedArg = WScript.Arguments.Named.Item(key)
    Else
        GetNamedArg = defaultValue
    End If
End Function

Function GetRequestValue(ByRef request, ByVal key, ByVal defaultValue)
    key = LCase(key)
    If request.Exists(key) Then
        GetRequestValue = request.Item(key)
    Else
        GetRequestValue = defaultValue
    End If
End Function

Function ParseLong(ByVal text, ByVal defaultValue)
    On Error Resume Next
    ParseLong = CLng(text)
    If Err.Number <> 0 Then
        ParseLong = defaultValue
        Err.Clear
    End If
    On Error GoTo 0
End Function

Function BoolToFlag(ByVal value)
    If value Then
        BoolToFlag = "1"
    Else
        BoolToFlag = "0"
    End If
End Function

Function FileExists(ByVal filePath)
    Dim fso

    Set fso = CreateObject("Scripting.FileSystemObject")
    FileExists = fso.FileExists(filePath)
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
    If IsNull(value) Then
        NullToEmpty = ""
    Else
        NullToEmpty = CStr(value)
    End If
End Function

Function SafeAscii(ByVal text)
    SafeAscii = Replace(Replace(NullToEmpty(text), vbCr, " "), vbLf, " ")
End Function

Function SafeGetAppDirectory(ByRef appRef)
    On Error Resume Next
    Err.Clear
    SafeGetAppDirectory = CStr(appRef.ApplicationDirectory)
    If Err.Number <> 0 Then
        SafeGetAppDirectory = ""
        Err.Clear
    End If
    On Error GoTo 0
End Function

Function SafeGetAppVersion(ByRef appRef)
    On Error Resume Next
    Err.Clear
    SafeGetAppVersion = CStr(appRef.Version)
    If Err.Number <> 0 Then
        SafeGetAppVersion = ""
        Err.Clear
    End If
    On Error GoTo 0
End Function

Function CanUseGenericComActivationForTarget(ByVal exePath)
    Dim shell
    Dim clsid
    Dim serverCommand

    CanUseGenericComActivationForTarget = False
    If Len(exePath) = 0 Then
        CanUseGenericComActivationForTarget = True
        Exit Function
    End If

    On Error Resume Next
    Set shell = CreateObject("WScript.Shell")
    clsid = CStr(shell.RegRead("HKEY_CLASSES_ROOT\LabVIEW.Application\CLSID\"))
    If Err.Number <> 0 Then
        Err.Clear
        On Error GoTo 0
        Exit Function
    End If

    serverCommand = CStr(shell.RegRead("HKEY_CLASSES_ROOT\CLSID\" & clsid & "\LocalServer32\"))
    If Err.Number <> 0 Then
        Err.Clear
        On Error GoTo 0
        Exit Function
    End If
    On Error GoTo 0

    CanUseGenericComActivationForTarget = (NormalizePath(ExtractExecutablePath(serverCommand)) = NormalizePath(exePath))
End Function

Function ExtractExecutablePath(ByVal commandText)
    Dim trimmed
    Dim quotePos
    Dim exePos

    trimmed = Trim(CStr(commandText))
    If Len(trimmed) = 0 Then
        ExtractExecutablePath = ""
        Exit Function
    End If

    If Left(trimmed, 1) = """" Then
        quotePos = InStr(2, trimmed, """")
        If quotePos > 1 Then
            ExtractExecutablePath = Mid(trimmed, 2, quotePos - 2)
            Exit Function
        End If
    End If

    exePos = InStr(1, LCase(trimmed), ".exe")
    If exePos > 0 Then
        ExtractExecutablePath = Left(trimmed, exePos + 3)
    Else
        ExtractExecutablePath = trimmed
    End If
End Function

Sub ReleaseComObject(ByRef objRef)
    On Error Resume Next
    Set objRef = Nothing
    On Error GoTo 0
End Sub

Function EncodeBase64Utf8(ByVal text)
    Dim stream
    Dim xml
    Dim node
    Dim bytes

    Set stream = CreateObject("ADODB.Stream")
    stream.Type = 2
    stream.Charset = "utf-8"
    stream.Open
    stream.WriteText NullToEmpty(text)
    stream.Position = 0
    stream.Type = 1
    bytes = stream.Read
    stream.Close

    Set xml = CreateObject("Msxml2.DOMDocument.6.0")
    Set node = xml.CreateElement("base64")
    node.DataType = "bin.base64"
    node.NodeTypedValue = bytes
    EncodeBase64Utf8 = Replace(Replace(node.Text, vbCr, ""), vbLf, "")
End Function

Function DecodeBase64Utf8(ByVal base64Text)
    Dim xml
    Dim node
    Dim stream
    Dim bytes

    If Len(base64Text) = 0 Then
        DecodeBase64Utf8 = ""
        Exit Function
    End If

    Set xml = CreateObject("Msxml2.DOMDocument.6.0")
    Set node = xml.CreateElement("base64")
    node.DataType = "bin.base64"
    node.Text = base64Text
    bytes = node.NodeTypedValue

    Set stream = CreateObject("ADODB.Stream")
    stream.Type = 1
    stream.Open
    stream.Write bytes
    stream.Position = 0
    stream.Type = 2
    stream.Charset = "utf-8"
    DecodeBase64Utf8 = stream.ReadText
    stream.Close
End Function

Function QuoteArg(ByVal text)
    QuoteArg = Chr(34) & Replace(text, Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function