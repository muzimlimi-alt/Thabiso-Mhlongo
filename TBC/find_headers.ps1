$lines = Get-Content 'admin.html'
$sections = @(
    "dashboardAdmin", "usersAdmin", "inquiriesAdmin", "bookingsAdmin", "calendarAdmin", 
    "financeAdmin", "servicesAdmin", "policiesAdmin", "homeAdmin", "aboutAdmin", 
    "careerAdmin", "galleryAdmin", "socialAdmin", "eventsAdmin", "contactAdmin", 
    "newsletterAdmin", "preferencesAdmin", "brandingAdmin", "emailLogsAdmin", "securityAdmin"
)

Write-Host "--- Section Header Locations ---"
for ($i = 0; $i -lt $lines.Length; $i++) {
    foreach ($sec in $sections) {
        if ($lines[$i] -match "id=`"${sec}`"") {
            Write-Host "Section: ${sec} starts at line $($i + 1)"
            # Look for the heading tag in the next 30 lines
            for ($j = $i; $j -lt ($i + 30) -and $j -lt $lines.Length; $j++) {
                if ($lines[$j] -match "<h[1-2]|class=`"um-page-title`"|class=`"um-title`"") {
                    Write-Host "  Header tag at line $($j + 1): $($lines[$j].Trim())"
                    # Also print preceding and succeeding lines for context
                    Write-Host "    $($lines[$j-1].Trim())"
                    Write-Host "    $($lines[$j].Trim())"
                    Write-Host "    $($lines[$j+1].Trim())"
                }
            }
        }
    }
}
