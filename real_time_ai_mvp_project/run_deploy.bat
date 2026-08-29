@echo off
rem Deploy to VPS via SSH. Output: deploy_result.txt
rem If asked for a password/passphrase, type it in this window.
cd /d "%~dp0"
echo Connecting to VPS and running update.sh ...
ssh root@mvp.ai-l-a-b-o.com "cd /opt/rt-mvp && bash scripts/update.sh" > deploy_result.txt 2>&1
echo.
echo Done. Tell Claude "finished".
pause
