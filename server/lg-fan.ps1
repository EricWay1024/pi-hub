# $RequestedMode is injected as a validated integer by server/fan.ts; -1 means read only.
# Use the installed LG API; never write EC registers or load third-party drivers.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
    $computer = Get-CimInstance Win32_ComputerSystem
    if ($computer.Manufacturer -notmatch '^LG Electronics') { throw 'This computer is not an LG laptop.' }
    $dll = Join-Path ${env:ProgramFiles(x86)} 'LG Software\LG Smart Assistant\WindowsControl.dll'
    if (!(Test-Path -LiteralPath $dll)) { throw 'LG Smart Assistant is not installed.' }
    $assembly = [Reflection.Assembly]::LoadFrom($dll)
    $device = [Activator]::CreateInstance($assembly.GetType('WindowsControl.LGDeviceController', $true))
    $type = $device.GetFanModeType().ToString()
    # These are Set_SystemTempMode arguments, not the separate FanModeValue enum.
    $allowed = switch ($type) {
        'ThreeLevel' { @(0, 1, 2) }
        'FourLevel' { @(3, 0, 1, 2) }
        'FourLevelBoost' { @(0, 1, 2, 4) }
        'FivelLevelAuto' { @(5, 3, 0, 1, 2) }
        'FourLevelMax' { @(0, 1, 2, 6) }
        default { throw 'This LG cooling interface is not supported.' }
    }
    $current = $device.Get_SystemTempMode()
    if ($allowed -notcontains $current) { throw 'LG did not return a recognized cooling mode.' }
    if ($RequestedMode -ne -1) {
        if ($allowed -notcontains $RequestedMode) { throw 'This cooling mode is not supported by this laptop.' }
        if ($current -ne $RequestedMode) {
            $result = $device.Set_SystemTempMode([int]$RequestedMode)
            if ($result -ne 0) { throw 'LG rejected the cooling mode change. Refresh before trying again.' }
            for ($attempt = 0; $attempt -lt 5; $attempt++) {
                Start-Sleep -Milliseconds 200
                $current = $device.Get_SystemTempMode()
                if ($current -eq $RequestedMode) { break }
            }
            if ($current -ne $RequestedMode) { throw 'The cooling mode change could not be confirmed. Refresh before trying again.' }
        }
    }
    @{ model = $computer.Model; type = $type; value = [int]$current } | ConvertTo-Json -Compress
} catch {
    # Do not dump assembly paths, stack traces, or arbitrary vendor diagnostics to the browser.
    [Console]::Error.WriteLine('LG cooling interface unavailable or change not confirmed. Check LG Smart Assistant locally; refresh before retrying.')
    exit 1
}
