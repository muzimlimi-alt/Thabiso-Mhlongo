# Load admin.html
$html = Get-Content 'admin.html' -Raw

# 1. Check if sections use the 'atl-section-hd' pattern
Write-Host "--- Heading Patterns in admin.html ---"
$headerMatches = [regex]::Matches($html, '(?i)<div\s+class="atl-section-hd"')
Write-Host "Found $($headerMatches.Count) instances of 'atl-section-hd'"

$oldHeaders = [regex]::Matches($html, '(?i)<h2[^>]*style=')
Write-Host "Found $($oldHeaders.Count) h2 elements with inline style attributes"

# 2. Check for hardcoded colors in inline styles
Write-Host "`n--- Hardcoded Color Audit in admin.html ---"
$hexColors = [regex]::Matches($html, '#([0-9a-fA-F]{3,6})')
$uniqueHexColors = $hexColors | Select-Object -ExpandProperty Value -Unique
Write-Host "Total unique hex colors found in admin.html: $($uniqueHexColors.Count)"
Write-Host "Sample hex colors: ($($uniqueHexColors -join ', '))"

# 3. Check for specific sections from prompt and their current heading style
$sections = @(
    "dashboardAdmin", "usersAdmin", "inquiriesAdmin", "bookingsAdmin", "calendarAdmin", 
    "financeAdmin", "servicesAdmin", "policiesAdmin", "homeAdmin", "aboutAdmin", 
    "careerAdmin", "galleryAdmin", "socialAdmin", "eventsAdmin", "contactAdmin", 
    "newsletterAdmin", "preferencesAdmin", "brandingAdmin", "emailLogsAdmin", "securityAdmin"
)

Write-Host "`n--- Section Heading Analysis ---"
foreach ($sec in $sections) {
    if ($html -match "(?s)id=`"${sec}`".*?<h[1-2]([^>]*?)>(.*?)</h[1-2]>") {
        $attrs = $Matches[1].Trim()
        $content = $Matches[2].Trim()
        Write-Host "${sec}: Has heading with content '$content' (attrs: $attrs)"
    } else {
        Write-Host "${sec}: Heading tag not matched directly"
    }
}
