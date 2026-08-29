@echo off
rem Commit and push all changes. Output: push_result.txt
cd /d "%~dp0"
echo [1/3] git add ...
git add -A > push_result.txt 2>&1
echo [2/3] git commit ...
git commit -m "fix: trigger recovery paths, manual generate button, document edit UI, Windows path compat" >> push_result.txt 2>&1
echo [3/3] git push ...
git push >> push_result.txt 2>&1
echo.
echo Done. Tell Claude "finished".
pause
