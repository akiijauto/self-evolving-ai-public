@echo off
rem Run all workspace tests and save output to test_result.txt
cd /d "%~dp0"
echo Running npm test ... please wait (may take a few minutes)
call npm test > test_result.txt 2>&1
echo.
echo Done. Result saved to test_result.txt
echo Close this window and tell Claude "finished".
pause
