$lines = Get-Content 'admin.html'
for ($i = 0; $i -lt $lines.Length; $i++) {
    if ($lines[$i] -match "ApexCharts" -or $lines[$i] -match "new.*Chart\(") {
        Write-Host "Match at line $($i): $($lines[$i])"
    }
}
