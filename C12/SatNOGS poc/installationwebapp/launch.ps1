<#
SatNOGS installation launcher: starts the server (if it isn't running) and opens one
full-screen kiosk browser window per display listed in installation.json.

  .\launch.ps1             server + displays
  .\launch.ps1 -List       the screens, numbered left to right as "screen" counts them
  .\launch.ps1 -Windowed   small normal windows on this monitor instead, to try it out
  .\launch.ps1 -Stop       close the displays and stop the server

Kiosk windows have no browser UI: Alt+F4 closes the one in focus.
If scripts are blocked: powershell -ExecutionPolicy Bypass -File .\launch.ps1
#>
param([switch]$List, [switch]$Windowed, [switch]$Stop)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$config = Get-Content -Raw -Encoding UTF8 (Join-Path $here 'installation.json') | ConvertFrom-Json
$port = 5180
if ($config.server -and $config.server.port) { $port = $config.server.port }
$base = "http://127.0.0.1:$port"
$profileRoot = Join-Path $env:LOCALAPPDATA 'satnogs-installation' # one browser profile per display
$pidFile = Join-Path $here 'server.pid'

# real pixel coordinates, also on scaled monitors
if (-not ('Satnogs.Dpi' -as [type])) {
    Add-Type -Namespace Satnogs -Name Dpi -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
}
[void][Satnogs.Dpi]::SetProcessDPIAware()
Add-Type -AssemblyName System.Windows.Forms
$screens = @([System.Windows.Forms.Screen]::AllScreens | Sort-Object { $_.Bounds.X }, { $_.Bounds.Y })

function Test-Server {
    try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "$base/health").StatusCode -eq 200 } catch { $false }
}

function Stop-Displays {
    Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe' OR Name = 'msedge.exe'" |
        Where-Object { $_.CommandLine -and $_.CommandLine.Contains($profileRoot) } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Stop-Server {
    if (-not (Test-Path $pidFile)) { return }
    $serverPid = [int](Get-Content $pidFile)
    Stop-Process -Id $serverPid -Force -ErrorAction SilentlyContinue
    Remove-Item $pidFile -ErrorAction SilentlyContinue
}

function Find-Browser {
    if ($config.browser) { return $config.browser }
    $candidates = @(
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
    )
    foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
    throw 'Chrome or Edge not found: set "browser" in installation.json to its .exe'
}

if ($List) {
    for ($i = 0; $i -lt $screens.Count; $i++) {
        $b = $screens[$i].Bounds
        $primary = if ($screens[$i].Primary) { '  (primary)' } else { '' }
        Write-Host ('screen {0}: {1}x{2} at {3},{4}{5}' -f ($i + 1), $b.Width, $b.Height, $b.X, $b.Y, $primary)
    }
    return
}

if ($Stop) {
    Stop-Displays
    Stop-Server
    Write-Host 'Displays closed, server stopped.'
    return
}

if (-not (Test-Server)) {
    if (-not (Test-Path (Join-Path $here 'dist\index.html'))) {
        Write-Host 'Building the displays (first run)...'
        & pnpm -C $here build
        if ($LASTEXITCODE -ne 0) { throw 'pnpm build failed' }
    }
    Write-Host "Starting the server on $base ..."
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'pnpm start' -WorkingDirectory $here -WindowStyle Minimized
    $deadline = (Get-Date).AddSeconds(60)
    while (-not (Test-Server)) {
        if ((Get-Date) -gt $deadline) { throw "the server didn't answer on $base" }
        Start-Sleep -Milliseconds 500
    }
}

Stop-Displays # launching again replaces the windows instead of stacking them
$browser = Find-Browser
$primary = ($screens | Where-Object { $_.Primary } | Select-Object -First 1).Bounds
$n = 0
foreach ($d in $config.displays) {
    $n++
    $query = "view=$($d.view)&id=$($d.view)-$n"
    if ($d.audio) { $query += '&audio=1' }
    if ($d.params) { $query += "&$($d.params)" }
    $url = "$base/?$query"
    $flags = @(
        "--user-data-dir=`"$profileRoot\display-$n`"",
        '--no-first-run', '--no-default-browser-check', '--disable-session-crashed-bubble',
        '--noerrdialogs', '--disable-infobars', '--disable-features=Translate',
        '--autoplay-policy=no-user-gesture-required', '--overscroll-history-navigation=0'
    )
    if ($Windowed) {
        $w = [int]($primary.Width / 3)
        $h = [int]($primary.Height / 2)
        $x = $primary.X + (($n - 1) % 3) * $w
        $y = $primary.Y + ([Math]::Floor(($n - 1) / 3) % 2) * $h
        $flags += "--window-position=$x,$y", "--window-size=$w,$h", "--app=`"$url`""
    } else {
        if ($d.position) {
            $pos = "$($d.position[0]),$($d.position[1])"
        } else {
            if ($d.screen -lt 1 -or $d.screen -gt $screens.Count) {
                Write-Warning "display $n ($($d.view)): there is no screen $($d.screen), skipped"
                continue
            }
            $b = $screens[$d.screen - 1].Bounds
            $pos = "$($b.X + 50),$($b.Y + 50)"
        }
        $flags += "--window-position=$pos", '--kiosk'
        if ($browser -like '*msedge.exe') { $flags += '--edge-kiosk-type=fullscreen' }
        $flags += "`"$url`""
    }
    Start-Process -FilePath $browser -ArgumentList $flags
    Write-Host "display $n -> $url"
    Start-Sleep -Milliseconds 700
}
