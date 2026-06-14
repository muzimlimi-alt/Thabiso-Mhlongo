$html = Get-Content 'admin.html' -Raw
$classes = @("fin-tile", "settings-panel", "log-row", "cms-card", "settings-row", "svc-card", "inq-folder", "um-user-card")
foreach ($cls in $classes) {
    $count = ([regex]::Matches($html, $cls)).Count
    Write-Host "Class '$cls': $count matches in admin.html"
}
