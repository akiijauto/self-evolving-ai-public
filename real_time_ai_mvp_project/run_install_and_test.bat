@echo off
rem Install project dependencies then run all tests.
rem Output: install_result.txt / test_result.txt
cd /d "%~dp0"
echo [1/2] npm install ... please wait (several minutes)
call npm install > install_result.txt 2>&1
echo [2/2] npm test ... please wait
call npm test > test_result.txt 2>&1
echo.
echo Done. Tell Claude "finished".
pause
