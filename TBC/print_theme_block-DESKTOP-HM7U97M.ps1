$html = Get-Content 'admin.html' -Raw
if ($html -match "(?is)(/\* =+.*?GLOBAL ADMIN THEME APPLICATION.*?\*/)(.*?)(</style>)") {
    Write-Host "Matched Theme Block!"
    $block = $Matches[2]
    Write-Host $block.Substring(0, [Math]::Min(3500, $block.Length))
} else {
    Write-Host "No match found for GLOBAL ADMIN THEME APPLICATION style block"
}
