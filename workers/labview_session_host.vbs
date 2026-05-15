Option Explicit

Const REQUEST_SUFFIX_TYPE = "_type"
Const REQUEST_SUFFIX_VAL  = "_val"
Const REQUEST_PART_TYPE   = "type"
Const REQUEST_PART_VAL    = "val"

Const RESPONSE_BEGIN = "__LABVIEW_RESPONSE_BEGIN__"
Const RESPONSE_END   = "__LABVIEW_RESPONSE_END__"

Const DEFAULT_TIMEOUT_SECONDS = 45
Const RETRY_INTERVAL_MS = 750
Const WAIT_FOR_REUSE_MS = 2500
Const PRINT_FORMAT_COMPLETE = 4
Const HTML_IMAGE_FORMAT_PNG = 0

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
writableMeta.Add "HistoryText", "String|vi"
writableMeta.Add "AllowDebugging", "Boolean|vi"
writableMeta.Add "ShowFPOnCall", "Boolean|vi"
writableMeta.Add "CloseFPAfterCall", "Boolean|vi"
writableMeta.Add "IsReentrant", "Boolean|vi"
writableMeta.Add "RunOnOpen", "Boolean|vi"
writableMeta.Add "PreferredExecSystem", "Number|vi"
writableMeta.Add "ExecPriority", "Number|vi"

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
            request.Item(key) = value
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
    val = CStr(viRef.Description)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    AppendPropLine responseText, "Description", "String", ok, val, errMsg

    val = "" : Err.Clear
    val = CStr(viRef.HistoryText)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    AppendPropLine responseText, "HistoryText", "String", ok, val, errMsg

    val = "" : Err.Clear
    val = CStr(viRef.AllowDebugging)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    AppendPropLine responseText, "AllowDebugging", "Boolean", ok, val, errMsg

    val = "" : Err.Clear
    val = CStr(viRef.ShowFPOnCall)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    AppendPropLine responseText, "ShowFPOnCall", "Boolean", ok, val, errMsg

    val = "" : Err.Clear
    val = CStr(viRef.CloseFPAfterCall)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    AppendPropLine responseText, "CloseFPAfterCall", "Boolean", ok, val, errMsg

    val = "" : Err.Clear
    val = CStr(viRef.IsReentrant)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    AppendPropLine responseText, "IsReentrant", "Boolean", ok, val, errMsg

    val = "" : Err.Clear
    val = CStr(viRef.RunOnOpen)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    AppendPropLine responseText, "RunOnOpen", "Boolean", ok, val, errMsg

    val = "" : Err.Clear
    val = CStr(viRef.PreferredExecSystem)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    AppendPropLine responseText, "PreferredExecSystem", "Number", ok, val, errMsg

    val = "" : Err.Clear
    val = CStr(viRef.ExecPriority)
    ok = (Err.Number = 0) : errMsg = Err.Description : Err.Clear
    AppendPropLine responseText, "ExecPriority", "Number", ok, val, errMsg

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
        Case "HistoryText"         : viRef.HistoryText = CStr(newVal)
        Case "AllowDebugging"      : viRef.AllowDebugging = CoerceBool(newVal)
        Case "ShowFPOnCall"        : viRef.ShowFPOnCall = CoerceBool(newVal)
        Case "CloseFPAfterCall"    : viRef.CloseFPAfterCall = CoerceBool(newVal)
        Case "IsReentrant"         : viRef.IsReentrant = CoerceBool(newVal)
        Case "RunOnOpen"           : viRef.RunOnOpen = CoerceBool(newVal)
        Case "PreferredExecSystem" : viRef.PreferredExecSystem = CLng(newVal)
        Case "ExecPriority"        : viRef.ExecPriority = CLng(newVal)
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
        Case "HistoryText"         : val = CStr(viRef.HistoryText)
        Case "AllowDebugging"      : val = CStr(viRef.AllowDebugging)
        Case "ShowFPOnCall"        : val = CStr(viRef.ShowFPOnCall)
        Case "CloseFPAfterCall"    : val = CStr(viRef.CloseFPAfterCall)
        Case "IsReentrant"         : val = CStr(viRef.IsReentrant)
        Case "RunOnOpen"           : val = CStr(viRef.RunOnOpen)
        Case "PreferredExecSystem" : val = CStr(viRef.PreferredExecSystem)
        Case "ExecPriority"        : val = CStr(viRef.ExecPriority)
    End Select
    If Err.Number <> 0 Then
        val = ""
        Err.Clear
    End If
    On Error GoTo 0
    ReadBackVi = val
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

Sub ExportPanelImages(ByRef viRef, ByVal fpFinalOutputPath, ByVal bdFinalOutputPath, ByRef exportedOutputPath, ByRef exportedFpOutputPath, ByRef exportedBdOutputPath)
    Dim fso
    Dim tempRoot
    Dim exportRoot
    Dim htmlPath
    Dim imageDir
    Dim sourcePath

    exportedOutputPath = ""
    exportedFpOutputPath = ""
    exportedBdOutputPath = ""

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
        Dim invokeError
        invokeError = Err.Description
        CleanupFolder exportRoot
        Err.Raise vbObjectError + 401, , "PrintVIToHTML failed: " & invokeError
    End If

    If Len(fpFinalOutputPath) > 0 Then
        sourcePath = FindExportedImage(imageDir, "p.png")
        If Len(sourcePath) = 0 Then
            CleanupFolder exportRoot
            Err.Raise vbObjectError + 402, , "LabVIEW HTML export did not produce *p.png."
        End If
        EnsureParentFolder fpFinalOutputPath
        fso.CopyFile sourcePath, fpFinalOutputPath, True
        exportedFpOutputPath = fpFinalOutputPath
        exportedOutputPath = fpFinalOutputPath
    End If

    If Len(bdFinalOutputPath) > 0 Then
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
    Dim guidSource
    Dim candidate

    Set fso = CreateObject("Scripting.FileSystemObject")
    Set guidSource = CreateObject("Scriptlet.TypeLib")
    candidate = Replace(Replace(guidSource.Guid, "{", ""), "}", "")
    BuildUniqueTempDir = fso.BuildPath(baseDir, prefix & candidate)
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