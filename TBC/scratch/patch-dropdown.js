// Patch: Fix dropdown toggle to open upward with position:fixed
const fs = require('fs');
let lines = fs.readFileSync('admin.html', 'utf8').split('\n');

const newHandler = [
    '        // More dropdown toggle - opens upward with position:fixed',
    '        $(document).on(\'click\', \'.bk-action-more\', function(e) {',
    '            e.stopPropagation();',
    '            var $btn = $(this);',
    '            var $dd = $btn.siblings(\'.bkr-more-dropdown\');',
    '            // Hide all other dropdowns',
    '            $(\'.bkr-more-dropdown\').not($dd).hide();',
    '            // Toggle',
    '            if ($dd.is(\':visible\')) { $dd.hide(); return; }',
    '            // Position it: fixed, above the button',
    '            var rect = $btn[0].getBoundingClientRect();',
    '            $dd.css({',
    '                top: \'auto\',',
    '                bottom: (window.innerHeight - rect.top + 6) + \'px\',',
    '                right: (window.innerWidth - rect.right) + \'px\',',
    '                left: \'auto\'',
    '            }).show();',
    '        });',
];

// Replace lines 6997-7003 (0-indexed: 6996-7002, 7 lines)
lines.splice(6996, 7, ...newHandler.map(l => l + '\r'));
fs.writeFileSync('admin.html', lines.join('\n'), 'utf8');
console.log('Done. Dropdown toggle replaced. Total lines:', lines.length);
