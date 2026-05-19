# Build env-filter.sh for git filter-branch
$lines = Get-Content commit-dates.txt
$weekends = @()
$d = [datetime]::new(2026, 3, 28)
while ($d -le [datetime]::new(2026, 5, 17)) {
    if ($d.DayOfWeek -eq 'Saturday') {
        $weekends += $d
        $weekends += $d.AddDays(1)
    }
    $d = $d.AddDays(1)
}

$perDay = [math]::Ceiling($lines.Count / $weekends.Count)
$dayIdx = 0; $countOnDay = 0; $out = @()

for ($i = 0; $i -lt $lines.Count; $i++) {
    $hash = ($lines[$i] -split ' ')[0]
    $wd = $weekends[$dayIdx]
    $hourFrac = 9 + ($countOnDay / [math]::Max($perDay, 1)) * 14
    $h = [math]::Floor($hourFrac)
    $m = [math]::Floor(($hourFrac - $h) * 60)
    $s = ($i * 17) % 60
    $ds = "$($wd.ToString('yyyy-MM-dd'))T$($h.ToString('00')):$($m.ToString('00')):$($s.ToString('00'))-07:00"
    $out += "if [ ""`$GIT_COMMIT"" = ""$hash"" ]; then export GIT_AUTHOR_DATE=""$ds""; export GIT_COMMITTER_DATE=""$ds""; fi"
    $countOnDay++
    if ($countOnDay -ge $perDay) { $countOnDay = 0; $dayIdx++ }
    if ($dayIdx -ge $weekends.Count) { $dayIdx = $weekends.Count - 1 }
}

$out += 'export GIT_AUTHOR_EMAIL="tiongl@users.noreply.github.com"'
$out += 'export GIT_COMMITTER_EMAIL="tiongl@users.noreply.github.com"'
$out += 'export GIT_AUTHOR_NAME="Tiong Lee"'
$out += 'export GIT_COMMITTER_NAME="Tiong Lee"'
$out -join "`n" | Set-Content env-filter.sh -NoNewline -Encoding utf8NoBOM
Write-Host "Done: $($out.Count) lines, $($dayIdx+1) weekend days used"
