$html = Get-Content 'admin.html' -Raw
if ($html -match "(?s)(<div class=`"admin-section`"[^>]*?id=`"dashboardAdmin`".*?)(<div class=`"admin-section`"[^>]*?id=)") {
    $dashboardHtml = $Matches[1]
    Write-Host "Dashboard HTML Length: $($dashboardHtml.Length)"
    
    # Check for specific words
    foreach ($word in @("db-stat-card", "db-social-card", "db-crm-card", "db-schedule-item", "stat-card")) {
        $count = ([regex]::Matches($dashboardHtml, $word)).Count
        Write-Host "Contains '$word': $count times"
    }
    
    # Print the first 1000 characters of dashboard HTML to inspect
    Write-Host "`n--- Sample Dashboard HTML ---"
    Write-Host $dashboardHtml.Substring(0, [Math]::Min(1500, $dashboardHtml.Length))
} else {
    Write-Host "Failed to extract dashboard section"
}
