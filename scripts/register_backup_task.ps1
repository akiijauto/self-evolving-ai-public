<#
.SYNOPSIS
    バックアップの定期実行をWindowsタスクスケジューラに登録する(フェーズD)。

.DESCRIPTION
    backup_run.py --apply を毎日決まった時刻に実行するタスクを登録する。

    claude.aiのルーティン(クラウド実行)ではなくWindowsタスクスケジューラを使う理由:
    バックアップ対象はこのPCのローカルファイルであり、クラウド上のエージェントからは
    そもそも読めないため。

    安全性: backup_run.py は削除を一切行わず、バックアップ先が直接編集されていた
    場合も上書きせずスキップする。したがって自動実行しても、意図しない消失は起きない。

.PARAMETER Dest
    バックアップ先。例: C:\context-backup

.PARAMETER Time
    毎日の実行時刻(24時間表記)。既定は 12:00。

.PARAMETER TaskName
    登録するタスク名。既定は SelfEvolvingAI-ContextBackup。

.PARAMETER Unregister
    登録を解除する。

.EXAMPLE
    # 何が登録されるかだけ確認する
    powershell -ExecutionPolicy Bypass -File scripts\register_backup_task.ps1 -Dest "C:\context-backup" -WhatIf

.EXAMPLE
    # 毎日12:00に実行するよう登録
    powershell -ExecutionPolicy Bypass -File scripts\register_backup_task.ps1 -Dest "C:\context-backup"

.EXAMPLE
    # 解除
    powershell -ExecutionPolicy Bypass -File scripts\register_backup_task.ps1 -Unregister
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$Dest,
    [string]$Time = "12:00",
    [string]$TaskName = "SelfEvolvingAI-ContextBackup",
    [switch]$Unregister
)

$ErrorActionPreference = "Stop"

if ($Unregister) {
    if (-not (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) {
        Write-Host "タスクが見つかりません: $TaskName"
        exit 0
    }
    if ($PSCmdlet.ShouldProcess($TaskName, "タスクの登録を解除")) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "登録を解除しました: $TaskName"
    }
    exit 0
}

if (-not $Dest) {
    Write-Error "-Dest でバックアップ先を指定してください(例: -Dest `"C:\context-backup`")"
    exit 1
}

# リポジトリのルート(このスクリプトの1つ上)
$repoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$runner = Join-Path $repoRoot "scripts\backup_run.py"
if (-not (Test-Path $runner)) {
    Write-Error "backup_run.py が見つかりません: $runner"
    exit 1
}

$python = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $python) { $python = (Get-Command py -ErrorAction SilentlyContinue).Source }
if (-not $python) {
    Write-Error "python が見つかりません。PATHを確認してください。"
    exit 1
}

# --date はスクリプト側で自動取得しない設計なので、実行時の日付をここで渡す。
# タスクスケジューラは1行のコマンドしか渡せないため、-Command で日付を組み立てる。
$inner = "& '$python' '$runner' --date (Get-Date -Format 'yyyy-MM-dd') --dest '$Dest' --apply"
$argument = "-NoProfile -ExecutionPolicy Bypass -Command `"$inner`""

Write-Host "登録内容:"
Write-Host "  タスク名 : $TaskName"
Write-Host "  実行時刻 : 毎日 $Time"
Write-Host "  作業場所 : $repoRoot"
Write-Host "  コマンド : powershell $argument"
Write-Host ""

if ($PSCmdlet.ShouldProcess($TaskName, "タスクスケジューラへ登録")) {
    $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $argument -WorkingDirectory $repoRoot
    $trigger = New-ScheduledTaskTrigger -Daily -At $Time
    # PCが起動していなかった場合に取りこぼさないよう、起動後に遅れて実行させる
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries `
        -AllowStartIfOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 2)

    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
        -Settings $settings -Description "self-evolving-ai: ローカルPCコンテキストのバックアップ" -Force | Out-Null

    Write-Host "登録しました: $TaskName"
    Write-Host ""
    Write-Host "確認:   Get-ScheduledTask -TaskName $TaskName"
    Write-Host "手動実行: Start-ScheduledTask -TaskName $TaskName"
    Write-Host "実行履歴: Get-ScheduledTaskInfo -TaskName $TaskName"
    Write-Host "解除:   powershell -ExecutionPolicy Bypass -File scripts\register_backup_task.ps1 -Unregister"
}
