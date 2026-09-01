# Daiva Health / Automation Web Platform - Prerequisite Installer
# Installs: Node.js, Git, Python 3
# Then: npm install (backend + frontend), pip install + playwright install (runner), .env setup
# Does NOT install PostgreSQL - see README.md for that.
#
# Every tool is installed via winget FIRST, and falls back to a direct
# download from the tool's own official source if winget is missing, broken,
# or the specific install/upgrade call fails -- so this keeps working even on
# a machine where winget itself is corrupted.

trap {
    Write-Host ""
    Write-Host "=================================================" -ForegroundColor Red
    Write-Host "  Something went wrong:" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host "=================================================" -ForegroundColor Red
    Write-Host ""
    Read-Host "Press Enter to close"
    exit 1
}

# -- Self-elevate if not already running as Administrator -------------------
$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$isAdmin = $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Host "This installer needs administrator permission to install software."
    Write-Host "A Windows prompt (User Account Control) should appear - click YES on it."
    Write-Host ""
    $scriptPath = $MyInvocation.MyCommand.Path
    $psArgs = @(
        "-NoProfile"
        "-ExecutionPolicy", "Bypass"
        "-File", "`"$scriptPath`""
    )
    $proc = Start-Process -FilePath "powershell.exe" -ArgumentList $psArgs -Verb RunAs -Wait -PassThru -ErrorAction SilentlyContinue
    if (-not $proc) {
        Write-Host ""
        Write-Host "The administrator prompt was cancelled, or failed to open." -ForegroundColor Red
        Write-Host "Right-click Install-Prerequisites.bat and choose 'Run as administrator' instead." -ForegroundColor Yellow
        Write-Host ""
        Read-Host "Press Enter to close"
    }
    exit
}

Write-Host ""
Write-Host "=================================================" -ForegroundColor Cyan
Write-Host "  Automation Web Platform - Prerequisite Installer" -ForegroundColor Cyan
Write-Host "=================================================" -ForegroundColor Cyan
Write-Host "This installs: Node.js, Git, and Python 3."
Write-Host "PostgreSQL is NOT installed by this script - set that up separately."
Write-Host ""

$results = @()
$script:wingetBroken = $false

function Confirm-YesNo {
    param([string]$Question)
    $answer = Read-Host "$Question [y/N]"
    return ($answer -match '^(y|yes)$')
}

# Refresh $env:Path in THIS window from the registry (Machine + User) so a
# tool installed a moment ago is usable immediately, without needing to
# close and reopen the terminal.
function Update-SessionPath {
    try {
        $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
        $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
        $env:Path = "$machinePath;$userPath"
    } catch {}
}

# -- winget availability + health check --------------------------------------
if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Write-Host "'winget' was not found on this machine." -ForegroundColor Yellow
    Write-Host "It comes from the 'App Installer' app in the Microsoft Store." -ForegroundColor Yellow
    Write-Host "This script will still work without it -- it downloads tools directly instead." -ForegroundColor Yellow
    if (Confirm-YesNo "Open the Microsoft Store page for App Installer anyway?") {
        try { Start-Process "ms-windows-store://pdp/?productid=9NBLGGH4NNS1" } catch {}
        Read-Host "Press Enter once you're done (or to skip) to continue"
        Update-SessionPath
    }
    $script:wingetBroken = $true
} else {
    Write-Host ">> Checking winget itself is working..." -ForegroundColor Cyan
    $wingetHealthOutput = (winget search Microsoft.WindowsTerminal --accept-source-agreements 2>&1) | Out-String
    if ($wingetHealthOutput -match 'Data required by the source is missing' -or $wingetHealthOutput -match 'Failed when searching source') {
        Write-Host "   winget's local source cache looks corrupted." -ForegroundColor Red
        $firstErrLine = ($wingetHealthOutput -split "`r`n|`n" | Where-Object { $_.Trim() } | Select-Object -First 1)
        Write-Host "   ($firstErrLine)" -ForegroundColor Red
        if (Confirm-YesNo "   Try to reset winget's sources now (winget source reset --force)?") {
            winget source reset --force
            Write-Host "   Re-checking..." -ForegroundColor Yellow
            $wingetHealthOutput2 = (winget search Microsoft.WindowsTerminal --accept-source-agreements 2>&1) | Out-String
            if ($wingetHealthOutput2 -match 'Data required by the source is missing' -or $wingetHealthOutput2 -match 'Failed when searching source') {
                Write-Host "   Still broken after reset. Falling back to direct downloads for everything below." -ForegroundColor Yellow
                $script:wingetBroken = $true
            } else {
                Write-Host "   Fixed." -ForegroundColor Green
            }
        } else {
            Write-Host "   OK -- falling back to direct downloads for everything below." -ForegroundColor Yellow
            $script:wingetBroken = $true
        }
    } else {
        Write-Host "   winget is working normally." -ForegroundColor Green
    }
}
Write-Host ""

# ==============================================================================
# Direct-download fallback installers
# ==============================================================================

function Install-NodeDirect {
    try {
        Write-Host "   Downloading Node.js LTS directly from nodejs.org..." -ForegroundColor Yellow
        $releases = Invoke-RestMethod -Uri "https://nodejs.org/dist/index.json" -UseBasicParsing
        $lts = $releases | Where-Object { $_.lts } | Select-Object -First 1
        if (-not $lts) { return $false }
        $url = "https://nodejs.org/dist/$($lts.version)/node-$($lts.version)-x64.msi"
        $tmp = Join-Path $env:TEMP "daiva-node-lts.msi"
        Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing
        Start-Process "msiexec.exe" -ArgumentList @("/i", "`"$tmp`"", "/qn", "/norestart") -Wait
        Remove-Item $tmp -ErrorAction SilentlyContinue
        Update-SessionPath
        return $true
    } catch {
        Write-Host "   Direct download failed: $($_.Exception.Message)" -ForegroundColor Red
        return $false
    }
}

function Install-GitDirect {
    try {
        Write-Host "   Downloading Git directly from GitHub releases..." -ForegroundColor Yellow
        $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/git-for-windows/git/releases/latest" -Headers @{ "User-Agent" = "Daiva-Automation-Installer" } -UseBasicParsing
        $asset = $rel.assets | Where-Object { $_.name -match '64-bit\.exe$' } | Select-Object -First 1
        if (-not $asset) { return $false }
        $tmp = Join-Path $env:TEMP $asset.name
        Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $tmp -UseBasicParsing
        Start-Process $tmp -ArgumentList @("/VERYSILENT", "/NORESTART") -Wait
        Remove-Item $tmp -ErrorAction SilentlyContinue
        Update-SessionPath
        return $true
    } catch {
        Write-Host "   Direct download failed: $($_.Exception.Message)" -ForegroundColor Red
        return $false
    }
}

function Install-PythonDirect {
    try {
        Write-Host "   Downloading Python 3 directly from python.org..." -ForegroundColor Yellow
        # python.org has no single version-less "latest" URL like Node/Adoptium/Google do,
        # so this uses a recent known-good 3.12.x build. If this becomes stale, winget
        # (Python.Python.3.12) is tried first anyway -- this is only the last-resort path.
        $url = "https://www.python.org/ftp/python/3.12.7/python-3.12.7-amd64.exe"
        $tmp = Join-Path $env:TEMP "daiva-python312.exe"
        Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing
        # InstallAllUsers + PrependPath so 'python' and 'pip' are on PATH machine-wide
        Start-Process $tmp -ArgumentList @("/quiet", "InstallAllUsers=1", "PrependPath=1", "Include_test=0") -Wait
        Remove-Item $tmp -ErrorAction SilentlyContinue
        Update-SessionPath
        return $true
    } catch {
        Write-Host "   Direct download failed: $($_.Exception.Message)" -ForegroundColor Red
        return $false
    }
}

# ==============================================================================
# Install / upgrade helpers
# ==============================================================================

function Test-And-Install {
    param(
        [string]$Name,
        [string]$CheckExe,
        [string[]]$CheckArgs,
        [string]$WingetId,
        [scriptblock]$DirectInstall
    )
    Write-Host ">> Checking $Name..." -ForegroundColor Cyan
    $found = $false
    try {
        & $CheckExe @CheckArgs *> $null
        $found = $true
    } catch {
        $found = $false
    }

    if ($found) {
        Write-Host "   Already installed - skipping." -ForegroundColor Green
        $script:results += "[OK]      $Name - already installed"
        return
    }

    $installedOk = $false
    if (-not $script:wingetBroken -and (Get-Command winget -ErrorAction SilentlyContinue)) {
        Write-Host "   Not found - installing via winget (this can take a few minutes)..." -ForegroundColor Yellow
        winget install --id $WingetId --silent --accept-package-agreements --accept-source-agreements
        if ($LASTEXITCODE -eq 0) {
            $installedOk = $true
            Update-SessionPath
        } else {
            Write-Host "   winget install failed (exit code $LASTEXITCODE)." -ForegroundColor Red
        }
    } else {
        Write-Host "   Not found. winget isn't available/working, so downloading directly instead..." -ForegroundColor Yellow
    }

    if (-not $installedOk -and $DirectInstall) {
        $installedOk = & $DirectInstall
    }

    if ($installedOk) {
        $verified = $false
        try { & $CheckExe @CheckArgs *> $null; $verified = $true } catch { $verified = $false }
        if ($verified) {
            Write-Host "   $Name installed and verified working." -ForegroundColor Green
            $script:results += "[NEW]     $Name - installed"
        } else {
            Write-Host "   $Name installer ran, but it's not runnable in this window yet." -ForegroundColor Yellow
            Write-Host "   Close this window, open a NEW terminal, and check '$CheckExe $($CheckArgs -join ' ')'." -ForegroundColor Yellow
            $script:results += "[NEW]     $Name - installed (close/reopen terminal to use it)"
        }
    } else {
        Write-Host "   FAILED to install $Name automatically. Install it manually (see README.md)." -ForegroundColor Red
        $script:results += "[FAILED]  $Name - install manually, see README.md"
    }
    Write-Host ""
}

Test-And-Install -Name "Node.js" -CheckExe "node" -CheckArgs @("-v") -WingetId "OpenJS.NodeJS.LTS" -DirectInstall ${function:Install-NodeDirect}
Test-And-Install -Name "Git" -CheckExe "git" -CheckArgs @("--version") -WingetId "Git.Git" -DirectInstall ${function:Install-GitDirect}
Test-And-Install -Name "Python 3" -CheckExe "python" -CheckArgs @("--version") -WingetId "Python.Python.3.12" -DirectInstall ${function:Install-PythonDirect}

# -- Project setup: npm install (backend + frontend) --------------------------
Write-Host "=================================================" -ForegroundColor Cyan
Write-Host "  Project setup" -ForegroundColor Cyan
Write-Host "=================================================" -ForegroundColor Cyan

$rootPath = Split-Path $PSScriptRoot -Parent
Write-Host "Project root: $rootPath" -ForegroundColor Cyan
Update-SessionPath

$npmReady = [bool](Get-Command npm -ErrorAction SilentlyContinue)
if (-not $npmReady) {
    Write-Host "'npm' isn't available in this window yet (Node.js may have just been installed above)." -ForegroundColor Yellow
    Write-Host "Close this window, open a NEW terminal, and re-run this installer to continue." -ForegroundColor Yellow
    $script:results += "[SKIPPED] npm install (backend/frontend) - npm not on PATH yet, re-run after reopening a terminal"
} else {
    foreach ($sub in @("backend", "frontend")) {
        $subPath = Join-Path $rootPath $sub
        if (-not (Test-Path (Join-Path $subPath "package.json"))) {
            Write-Host "   No package.json found in $subPath - skipping." -ForegroundColor Yellow
            $script:results += "[SKIPPED] npm install ($sub) - no package.json found"
            continue
        }
        if (Confirm-YesNo "Run 'npm install' in $sub\ now? (can take a few minutes)") {
            Push-Location $subPath
            try {
                npm install
                Write-Host "   npm install completed in $sub\." -ForegroundColor Green
                $script:results += "[DONE]    npm install ($sub) - completed"
            } catch {
                Write-Host "   npm install failed in $sub\. Check the output above." -ForegroundColor Red
                $script:results += "[FAILED]  npm install ($sub) - failed, see output above"
            } finally {
                Pop-Location
            }
        } else {
            $script:results += "[SKIPPED] npm install ($sub) - skipped by user"
        }
    }
}
Write-Host ""

# -- Python path -> backend\.env ----------------------------------------------
# The backend spawns the test runner with PYTHON_PATH (server.js: PYTHON_CMD).
# Left unset it falls back to bare "python", which on Windows usually resolves
# to the Microsoft Store stub in WindowsApps -- that opens the Store instead of
# running Python, and every test run fails with no useful error. So find the
# real interpreter here and record it.
Write-Host "=================================================" -ForegroundColor Cyan
Write-Host "  Python path for the backend" -ForegroundColor Cyan
Write-Host "=================================================" -ForegroundColor Cyan

function Resolve-RealPython {
    # Machines often have SEVERAL interpreters, e.g.
    #    -V:3.14      ...\Python314\python.exe
    #    -V:3.12      ...\Python312\python.exe
    #    -V:3.11 *    ...\Python311\python.exe
    # Any of them runs, but only the one the runner's packages were pip-installed
    # into can actually run the tests. Preference order below is built to land on
    # that one rather than simply the newest.
    $candidates = @()

    # 1. 'py -0p' FIRST -- the launcher lists only properly REGISTERED Python
    #    installations. Interpreters bundled inside other applications (Nmap /
    #    Zenmap, GIMP, some vendor tools) never appear here, which is exactly
    #    what we want: they run, they report a version, and nothing the runner
    #    needs is installed in them. The launcher's default is marked '*'.
    try {
        $lines = @(& py -0p 2>$null)
        $starred = $lines | Where-Object { $_ -match '\*' }
        $others  = $lines | Where-Object { $_ -notmatch '\*' }
        foreach ($l in @($starred) + @($others)) {
            $path = ($l -split '\s{2,}')[-1]
            if ($path) { $candidates += $path.Trim() }
        }
    } catch {}

    # 2. Only then whatever bare 'python' resolves to. On a machine with Nmap
    #    installed this is C:\Program Files (x86)\Nmap\zenmap\bin\python.exe,
    #    so it must never outrank a registered install.
    try { $candidates += (& where.exe python 2>$null) } catch {}

    # Keep only interpreters that really exist and really run.
    $usable = @()
    foreach ($c in $candidates) {
        $exe = "$c".Trim()
        if (-not $exe) { continue }
        if ($exe -like "*\WindowsApps\*") { continue }   # Store stub: zero-byte, never usable
        # Interpreters shipped inside other products: they work, but they are
        # that product's private Python and pip-installing into them is wrong.
        if ($exe -match '\\(Nmap|zenmap|GIMP|Inkscape|QGIS|ArcGIS|MiKTeX)\\') { continue }
        if (-not (Test-Path $exe)) { continue }
        if ($usable -contains $exe) { continue }
        try {
            $v = & $exe --version 2>&1
            if ("$v" -match "Python 3") { $usable += (Resolve-Path $exe).Path }
        } catch { }
    }
    if ($usable.Count -eq 0) { return $null }

    # Prefer one that can already import playwright -- that is the interpreter
    # the runner needs, and the only way to tell them apart with certainty.
    foreach ($exe in $usable) {
        try {
            & $exe -c "import playwright" 2>$null | Out-Null
            if ($LASTEXITCODE -eq 0) {
                Write-Host "   (chose the interpreter that already has Playwright installed)" -ForegroundColor DarkGray
                return $exe
            }
        } catch { }
    }

    # None has it yet (e.g. pip install was skipped). Fall back to the first
    # usable one, which is bare 'python' where available.
    Write-Host "   (no interpreter has Playwright yet - using the default 'python')" -ForegroundColor DarkGray
    return $usable[0]
}

# Refresh PATH first: Python may have been installed a few steps ago in this
# same run, and this window's PATH would not know about it yet.
Update-SessionPath
$pythonExe  = Resolve-RealPython
# NOTE: backend/.env, not the root .env -- server.js calls dotenv.config() with
# no path, so it reads the .env in the folder the server is started from.
$backendEnv = Join-Path $rootPath "backend\.env"

if (-not $pythonExe) {
    Write-Host "   Could not find a real python.exe (only the Store stub, or none)." -ForegroundColor Yellow
    Write-Host "   Reopen a terminal after installing Python and re-run this script," -ForegroundColor Yellow
    Write-Host "   or set PYTHON_PATH in backend\.env by hand." -ForegroundColor Yellow
    $script:results += "[SKIPPED] PYTHON_PATH - no usable python.exe found"
} else {
    Write-Host "   Found Python: $pythonExe" -ForegroundColor Green
    if (-not (Test-Path $backendEnv)) {
        New-Item -ItemType File -Path $backendEnv -Force | Out-Null
        Write-Host "   Created $backendEnv" -ForegroundColor Yellow
    }
    $existing = @(Get-Content $backendEnv -ErrorAction SilentlyContinue)
    $replaced = $false
    $updated  = @(foreach ($line in $existing) {
        if ($line -match "^\s*PYTHON_PATH\s*=") { $replaced = $true; "PYTHON_PATH=$pythonExe" }
        else { $line }
    })
    # Rewrite in place rather than appending, so re-running never leaves two
    # PYTHON_PATH lines (dotenv would keep the first and ignore the new one).
    if (-not $replaced) { $updated = $updated + "PYTHON_PATH=$pythonExe" }
    Set-Content -Path $backendEnv -Value $updated -Encoding ASCII
    if ($replaced) { Write-Host "   PYTHON_PATH updated in backend\.env" -ForegroundColor Green }
    else           { Write-Host "   PYTHON_PATH added to backend\.env"   -ForegroundColor Green }
    $script:results += "[OK]      PYTHON_PATH - $pythonExe"
}
Write-Host ""

# -- Python runner setup: pip install + playwright install -------------------
# Playwright manages its own browser binaries (Chromium/Firefox/WebKit) --
# unlike Selenium, there's no separate driver-version-matching step needed.
Write-Host "=================================================" -ForegroundColor Cyan
Write-Host "  Python runner setup (pip + Playwright browsers)" -ForegroundColor Cyan
Write-Host "=================================================" -ForegroundColor Cyan
$runnerPath = Join-Path $rootPath "runner"
$reqPath = Join-Path $runnerPath "requirements.txt"
Update-SessionPath
# Use the interpreter resolved above ($pythonExe), NOT bare 'python'. On a
# machine with Nmap installed, bare 'python' is Nmap's bundled Zenmap
# interpreter -- the packages would land there (or fail), while PYTHON_PATH
# correctly points at the real install, and the runner then cannot import
# anything. Same interpreter for install and for run, always.
$pythonReady = [bool]$pythonExe

if (-not $pythonReady) {
    Write-Host "   No usable Python interpreter was found (see above)." -ForegroundColor Yellow
    Write-Host "   Close this window, open a NEW terminal, and re-run this installer to continue." -ForegroundColor Yellow
    $script:results += "[SKIPPED] Python runner setup - python not on PATH yet, re-run after reopening a terminal"
} elseif (-not (Test-Path $reqPath)) {
    Write-Host "   No requirements.txt found at $reqPath - skipping." -ForegroundColor Yellow
    $script:results += "[SKIPPED] Python runner setup - requirements.txt not found"
} else {
    if (Confirm-YesNo "Run 'pip install -r runner\requirements.txt' now?") {
        try {
            Write-Host "   Installing into: $pythonExe" -ForegroundColor DarkGray
            & $pythonExe -m pip install --upgrade pip
            & $pythonExe -m pip install -r $reqPath
            Write-Host "   Python packages installed." -ForegroundColor Green
            $script:results += "[DONE]    pip install -r runner/requirements.txt - completed"
        } catch {
            Write-Host "   pip install failed. Check the output above." -ForegroundColor Red
            $script:results += "[FAILED]  pip install -r runner/requirements.txt - failed, see output above"
        }
    } else {
        $script:results += "[SKIPPED] pip install -r runner/requirements.txt - skipped by user"
    }

    if (Confirm-YesNo "Download Playwright's browsers now (playwright install)? (needs internet, ~a few hundred MB)") {
        try {
            & $pythonExe -m playwright install
            Write-Host "   Playwright browsers installed." -ForegroundColor Green
            $script:results += "[DONE]    playwright install - completed"
        } catch {
            Write-Host "   playwright install failed. Check the output above." -ForegroundColor Red
            $script:results += "[FAILED]  playwright install - failed, see output above"
        }
    } else {
        $script:results += "[SKIPPED] playwright install - skipped by user"
    }
}
Write-Host ""

# -- .env setup ----------------------------------------------------------------
Write-Host "=================================================" -ForegroundColor Cyan
Write-Host "  .env setup" -ForegroundColor Cyan
Write-Host "=================================================" -ForegroundColor Cyan
$envExamplePath = Join-Path $rootPath ".env.example"
$envPath = Join-Path $rootPath ".env"

if (Test-Path $envPath) {
    Write-Host "   .env already exists at $envPath - leaving it as is." -ForegroundColor Green
    $script:results += "[OK]      .env - already exists, left untouched"
} elseif (-not (Test-Path $envExamplePath)) {
    Write-Host "   No .env.example found - can't create .env automatically." -ForegroundColor Yellow
    $script:results += "[SKIPPED] .env - no .env.example found to copy from"
} else {
    if (Confirm-YesNo "Create .env from .env.example now (you'll be asked for a few values)?") {
        $envLines = Get-Content $envExamplePath
        $newLines = @()
        foreach ($line in $envLines) {
            if ($line -match '^\s*#' -or $line -notmatch '=') { $newLines += $line; continue }
            $key = ($line -split '=', 2)[0].Trim()
            $defaultVal = ($line -split '=', 2)[1]
            if ($key -eq "ANTHROPIC_API_KEY") {
                $val = Read-Host "  ANTHROPIC_API_KEY (leave blank to skip AI features for now)"
                $newLines += "$key=$(if ($val) { $val } else { $defaultVal })"
            } elseif ($key -in @("POSTGRES_PASSWORD", "JWT_SECRET")) {
                $val = Read-Host "  $key (leave blank to use the example default -- change it before going to production)"
                $newLines += "$key=$(if ($val) { $val } else { $defaultVal })"
            } else {
                $newLines += $line
            }
        }
        Set-Content -Path $envPath -Value $newLines
        Write-Host "   .env created at $envPath." -ForegroundColor Green
        $script:results += "[NEW]     .env - created from .env.example"
    } else {
        $script:results += "[SKIPPED] .env - creation skipped by user"
    }
}
Write-Host ""

# -- Firewall: allow other machines on the SAME network to reach the frontend
# and backend ports. Everything else in this script can be perfectly correct
# (server binds to 0.0.0.0, Vite has host:true) and other machines on the LAN
# will STILL be unable to connect if Windows Firewall blocks the ports -- this
# often happens silently (a first-run prompt gets missed or dismissed) with no
# obvious error on either side. Scoped to the Private network profile only.
Write-Host "=================================================" -ForegroundColor Cyan
Write-Host "  Firewall (let other machines on this network connect)" -ForegroundColor Cyan
Write-Host "=================================================" -ForegroundColor Cyan
if (Confirm-YesNo "Allow inbound connections on ports 5176 (frontend) and 6001 (backend) for other machines on this network?") {
    try {
        $existing5176 = Get-NetFirewallRule -DisplayName "Daiva Automation - Frontend 5176" -ErrorAction SilentlyContinue
        if (-not $existing5176) {
            New-NetFirewallRule -DisplayName "Daiva Automation - Frontend 5176" -Direction Inbound -Protocol TCP -LocalPort 5176 -Action Allow -Profile Private | Out-Null
        }
        $existing6001 = Get-NetFirewallRule -DisplayName "Daiva Automation - Backend 6001" -ErrorAction SilentlyContinue
        if (-not $existing6001) {
            New-NetFirewallRule -DisplayName "Daiva Automation - Backend 6001" -Direction Inbound -Protocol TCP -LocalPort 6001 -Action Allow -Profile Private | Out-Null
        }
        Write-Host "   Firewall rules added (Private network profile only)." -ForegroundColor Green
        $script:results += "[FIXED]   Firewall - opened ports 5176 and 6001 for the Private network profile"
    } catch {
        Write-Host "   Could not add firewall rules automatically: $($_.Exception.Message)" -ForegroundColor Red
        Write-Host "   Add them manually in Windows Defender Firewall > Advanced Settings > Inbound Rules." -ForegroundColor Yellow
        $script:results += "[FAILED]  Firewall - could not add rules automatically, add manually"
    }
} else {
    $script:results += "[SKIPPED] Firewall - rule creation skipped by user (other machines may not be able to connect)"
}

# Show the LAN IP address(es) to share with other machines on the network.
try {
    $lanIps = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" -and $_.PrefixOrigin -ne "WellKnown" } |
        Select-Object -ExpandProperty IPAddress
    if ($lanIps) {
        Write-Host "   Other machines on this network can reach this server at:" -ForegroundColor Cyan
        foreach ($ip in $lanIps) { Write-Host "     http://${ip}:5176" -ForegroundColor Cyan }
    }
} catch {}
Write-Host ""

Write-Host "=================================================" -ForegroundColor Cyan
Write-Host "  Summary" -ForegroundColor Cyan
Write-Host "=================================================" -ForegroundColor Cyan
$results | ForEach-Object { Write-Host $_ }
Write-Host ""
Write-Host "NOTE: PostgreSQL was NOT installed by this script." -ForegroundColor Yellow
Write-Host "Install it yourself, then create a database matching your .env (POSTGRES_DB)." -ForegroundColor Yellow
Write-Host ""
Write-Host "To run the project (three separate terminals, all in this project folder):" -ForegroundColor Yellow
Write-Host "  1. cd backend  && npm start" -ForegroundColor Yellow
Write-Host "  2. cd frontend && npm run dev" -ForegroundColor Yellow
Write-Host "  3. python runner\async_runner.py   (or however the runner is started -- check its file)" -ForegroundColor Yellow
Write-Host ""
Write-Host "IMPORTANT: If anything above says 'close/reopen terminal to use it', do that first." -ForegroundColor Yellow
Write-Host ""
Read-Host "Press Enter to close"
