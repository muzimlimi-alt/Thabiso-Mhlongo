$lines = Get-Content 'admin.html'
for ($i = 0; $i -lt $lines.Length; $i++) {
    if ($lines[$i] -match "GLOBAL ADMIN THEME APPLICATION") {
        Write-Host "Found at line: $i"
        $start = [Math]::Max(0, $i - 10)
        $end = [Math]::Min($lines.Length - 1, $i + 150)
        for ($j = $start; $j -le $end; $j++) {
            Write-Host "$($j): $($lines[$j])"
        }
        break
    }
}
