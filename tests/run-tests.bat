@echo off
:: tests\run-tests.bat — Run the full test suite on Windows
::
:: What it does:
::   1. Starts proxy.js in a background window
::   2. Waits until it's accepting connections
::   3. Runs test-proxy.js  (core suite, 31 assertions)
::   4. Runs limits-test.js (boundary suite, 40 assertions)
::   5. Kills the proxy
::
:: Usage:
::   tests\run-tests.bat
:: Or via npm:
::   npm test

setlocal EnableDelayedExpansion

set "ROOT=%~dp0.."
set "TESTS=%~dp0"
set PORT=20128

:: Read PROXY_PORT from .env if present
if exist "%ROOT%\.env" (
    for /f "tokens=1,2 delims==" %%A in ('findstr /b "PROXY_PORT=" "%ROOT%\.env"') do set PORT=%%B
)

echo.
echo   Starting proxy.js...
start "ClaudeRelayProxy" /min node "%ROOT%\proxy.js"

:: Wait up to 15s for the proxy to come up
echo   Waiting for proxy on port %PORT%...
set READY=0
for /l %%i in (1,1,15) do (
    if !READY!==0 (
        curl -sf "http://127.0.0.1:%PORT%/health" >nul 2>&1 && set READY=1
        if !READY!==0 timeout /t 1 /nobreak >nul
    )
)

if %READY%==0 (
    echo ERROR: Proxy did not start within 15 seconds.
    exit /b 1
)
echo   Proxy is up!

:: Run test suites
set FAIL=0

node "%TESTS%test-proxy.js"
if errorlevel 1 set FAIL=1

echo.

node "%TESTS%limits-test.js"
if errorlevel 1 set FAIL=1

:: Kill the proxy
taskkill /fi "windowtitle eq ClaudeRelayProxy" /f >nul 2>&1

echo.
if !FAIL!==0 (
    echo   All test suites passed.
    exit /b 0
) else (
    echo   One or more test suites failed.
    exit /b 1
)
