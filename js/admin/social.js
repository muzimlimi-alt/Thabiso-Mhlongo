/* Phase 6 (HOUSEKEEPING-NOTES.md): relocated from admin.html verbatim — the "8. Dynamic Social
   Media Logic" block (social links CRUD, media embeds CRUD with per-platform oEmbed/metadata
   fetching, and the Dashboard follower-count KPI settings tab). A generic, cross-cutting
   $(document).ready(...) initializer (page-wide drag-drop prevention + several commented-out
   legacy init calls spanning many other sections) sat immediately after this block in
   admin.html and was NOT moved — it stays there. window.openSocialLinkDrawer/
   window.openSocialEmbedDrawer/window.toggleKpiFields/window.saveSocialKpiSettings were already
   window-attached in the original source (all three referenced from static onclick="" attributes
   in the section markup) — kept exactly as-is. loadAnalyticsDashboard(), called from
   saveSocialKpiSettings, is Dashboard's own function, defined much later in admin.html — an
   ordinary cross-script-block call, left untouched. */


// API-driven Social Media Logic
let globalSocialData = [];

async function renderSocialList() {
    try {
        globalSocialData = await apiCall('/api/admin/social_links');
        var $list = $('#adminSocialList');
        $list.empty();

        if (globalSocialData.length === 0) {
            $list.append('<p class="text-muted">No social links added yet.</p>');
            return;
        }

        globalSocialData.forEach(function (item, index) {
            var active = item.is_active != 0;
            var html = `
            <div class="embed-list-item" data-platform="${(item.platform_name || '').toLowerCase()}" style="display:flex; justify-content:space-between; align-items:center; padding: 12px; background: var(--atl-card); border-radius: 8px; margin-bottom: 12px; border: 1px solid var(--atl-line); transition: background 0.2s;">
                <div style="display:flex; gap:16px; align-items:center; flex: 1; overflow: hidden;">
                    <div style="width:40px; text-align:center; font-size:24px; flex-shrink:0;">
                        <i class="${item.icon_class}" title="${item.platform_name}" style="color: var(--atl-ink); text-shadow: 0px 0px 8px rgba(212, 175, 55,0.4);"></i>
                    </div>
                    <div style="display: flex; flex-direction: column; justify-content: center; flex: 1;">
                        <strong style="font-size: 15px; color: var(--atl-ink); margin-bottom: 4px; display:flex; align-items:center; gap:8px; flex-wrap:wrap;">${item.platform_name} <span class="atl-badge ${active ? 'atl-badge--confirmed' : 'atl-badge--unpaid'}">${active ? 'Active' : 'Inactive'}</span></strong>
                        <a href="${item.platform_url}" target="_blank" style="font-size:13px; color:var(--atl-muted); text-decoration:none;">${item.platform_url}</a>
                    </div>
                </div>
                <div style="display:flex; flex-direction:column; align-items:flex-end; gap:6px; flex-shrink:0; padding-left: 15px;">
                    <button type="button" class="atl-btn atl-btn--ghost um-btn--sm edit-social-action" data-index="${index}" title="Edit ${item.platform_name}" aria-label="Edit ${item.platform_name}">
                        <i class="fa-solid fa-pen"></i>
                    </button>
                    <button type="button" class="um-btn um-btn--danger um-btn--sm remove-social-action" data-id="${item.id}" title="Delete ${item.platform_name}" aria-label="Delete ${item.platform_name}">
                        <i class="fa-solid fa-trash-can"></i>
                    </button>
                </div>
            </div>`;
            $list.append(html);
        });
    } catch (err) {
        console.error("Failed to render social list", err);
        if (window.notificationService) window.notificationService.showError('Could not load social links. Please refresh.');
    }
}

const platformIconMap = {
    "Discord": "fa-brands fa-discord",
    "Facebook": "fa-brands fa-facebook",
    "Instagram": "fa-brands fa-instagram",
    "LinkedIn": "fa-brands fa-linkedin",
    "Microsoft Teams": "fa-brands fa-microsoft",
    "OnlyFans": "fa-solid fa-lock",
    "Pinterest": "fa-brands fa-pinterest",
    "Quora": "fa-brands fa-quora",
    "Reddit": "fa-brands fa-reddit",
    "Snapchat": "fa-brands fa-snapchat",
    "Spotify": "fa-brands fa-spotify",
    "Telegram": "fa-brands fa-telegram",
    "Threads": "fa-brands fa-threads",
    "TikTok": "fa-brands fa-tiktok",
    "Tumblr": "fa-brands fa-tumblr",
    "Twitch": "fa-brands fa-twitch",
    "WeChat": "fa-brands fa-weixin",
    "WhatsApp": "fa-brands fa-whatsapp",
    "X (Twitter)": "fa-brands fa-x-twitter",
    "YouTube": "fa-brands fa-youtube",
    "Vimeo": "fa-brands fa-vimeo",
    "Dailymotion": "fa-solid fa-circle-play",
    "Other": "fa-solid fa-link"
};

$(document).on('change', '#socName', function() {
    var val = $(this).val();
    var $preview = $('#iconPreviewDisplay');
    if (val && platformIconMap[val]) {
        $preview.html('<i class="' + platformIconMap[val] + '"></i>');
    } else {
        $preview.empty();
    }
});


// Open the Social Link drawer in create ("Add") mode.
window.openSocialLinkDrawer = function() {
    $('#socialIconForm')[0].reset();
    $('#socialIconForm').removeData('editing-id');
    $('#iconPreviewDisplay').empty();
    $('#socActive').prop('checked', true);
    $('#socActiveLabel').text('Active (visible on site)');
    $('#socialIconSubmitBtn').html('<i class="fa-solid fa-plus-circle"></i> Add Social Link').removeClass('btn-admin-warning btn-admin-success').addClass('btn-admin-primary');
    $('#socialLinkDrawerTitle').html('<i class="fa-solid fa-at"></i> Add Social Link');
    openAtlDrawer('socialLinkDrawer');
};

$(document).on('submit', '#socialIconForm', async function(e) {
    e.preventDefault();
    var name = $('#socName').val();
    var url = $('#socUrl').val().trim();
    var $btn = $('#socialIconSubmitBtn');
    var editingId = $('#socialIconForm').data('editing-id');

    if (!name) {
        window.notificationService.showError('Please select a platform.');
        return;
    }

    var iconClass = platformIconMap[name] || "fa-solid fa-link";

    try {
        await apiCall('/api/admin/social_links', 'POST', {
            id: editingId || null,
            platform_name: name,
            platform_url: url,
            icon_class: iconClass,
            is_active: $('#socActive').is(':checked')
        });

        $('#socialIconForm')[0].reset();
        $('#socialIconForm').removeData('editing-id');
        $('#iconPreviewDisplay').empty();
        $('#socActiveLabel').text('Active (visible on site)');
        renderSocialList();
        closeAtlDrawer('socialLinkDrawer');
        window.notificationService.showSuccess(editingId ? 'Social link updated.' : 'Social link added.');
        $btn.html('<i class="fa-solid fa-plus-circle"></i> Add Social Link').removeClass('btn-admin-success btn-admin-warning').addClass('btn-admin-primary');
    } catch (err) {
        window.notificationService.showError("Failed to save social link.");
    }
});

$(document).on('click', '.remove-social-action', async function(e) {
    e.preventDefault();
    if (await window.notificationService.showConfirm({ 
        title: "Remove Link",
        message: 'Are you sure you want to remove this social link?',
        isDestructive: true 
    })) {
        var id = $(this).data('id');
        try {
            await apiCall('/api/admin/social_links/' + id, 'DELETE');
            renderSocialList();
        } catch(err) {
            console.error('Delete social link failed:', err);
            if (window.notificationService) window.notificationService.showError('Could not delete the social link. Please try again.');
        }
    }
});

$(document).on('click', '.edit-social-action', function(e) {
    e.preventDefault();
    var index = $(this).data('index');
    var item = globalSocialData[index];
    
    $('#socName').val(item.platform_name).trigger('change');
    $('#socUrl').val(item.platform_url);
    $('#socialIconForm').data('editing-id', item.id);
    $('#socActive').prop('checked', item.is_active != 0);
    $('#socActiveLabel').text(item.is_active != 0 ? 'Active (visible on site)' : 'Inactive (hidden)');

    $('#socialIconSubmitBtn').html('<i class="fa-solid fa-floppy-disk"></i> Update Social Link').removeClass('btn-admin-primary btn-admin-success').addClass('btn-admin-warning');
    $('#socialLinkDrawerTitle').html('<i class="fa-solid fa-at"></i> Edit Social Link');
    openAtlDrawer('socialLinkDrawer');
    $('#socUrl').focus();
});

// [T3] Client-side filter for the two "Current Social Items" lists. Hides rather than
// re-renders, so the data-index edit lookups still resolve against the full globalSocialData/globalEmbedData.
function umFilterSocialList(listSel, query) {
    var q = (query || '').trim().toLowerCase();
    $(listSel).find('.embed-list-item').each(function() {
        var p = ($(this).data('platform') || '').toString();
        $(this).toggle(!q || p.indexOf(q) !== -1);
    });
}
$(document).on('input', '#socialLinkSearch', function() { umFilterSocialList('#adminSocialList', this.value); });
$(document).on('input', '#socialEmbedSearch', function() { umFilterSocialList('#adminEmbedList', this.value); });

let globalEmbedData = [];

async function renderEmbedList() {
    try {
        globalEmbedData = await apiCall('/api/admin/social_embeds');
        var $list = $('#adminEmbedList');
        $list.empty();

        if (globalEmbedData.length === 0) {
            $list.append('<p class="text-muted">No media embeds added yet.</p>');
            return;
        }

        function escapeHtml(unsafe) {
            return (unsafe || "").toString().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        }

        globalEmbedData.forEach((item, index) => {
            let meta = null;
            try { meta = item.metadata ? JSON.parse(item.metadata) : null; } catch(e) {}
            var active = item.is_active != 0;
            
            var GIF_BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
            var storedThumb = (meta && meta.thumbnail) ? meta.thumbnail : '';
            var safeThumb = (storedThumb && storedThumb !== GIF_BLANK) ? storedThumb : (function() {
                var ec = item.embed_code || '';
                var ytRe = ec.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([\w-]{11})/);
                return (ytRe && ytRe[1]) ? 'https://img.youtube.com/vi/' + ytRe[1] + '/hqdefault.jpg' : GIF_BLANK;
            }());
            var title = (meta && meta.title) ? meta.title : (item.platform_name + ' Embed');
            var channel = (meta && meta.channelName) ? meta.channelName : item.platform_name;
            
            var views = '';
            if (meta && meta.viewCount && meta.viewCount > 0) {
                views = meta.viewCount >= 1000 ? (meta.viewCount/1000).toFixed(1).replace('.0','') + 'k views' : meta.viewCount + ' views';
            }
            
            var dateStr = '';
            if (meta && meta.publishDate) {
                var d = new Date(meta.publishDate);
                var diffDays = Math.floor((Date.now() - d.getTime()) / 86400000);
                if (diffDays === 0) dateStr = 'Today';
                else if (diffDays === 1) dateStr = '1 day ago';
                else if (diffDays < 30) dateStr = diffDays + ' days ago';
                else if (diffDays < 365) dateStr = Math.floor(diffDays/30) + ' months ago';
                else dateStr = Math.floor(diffDays/365) + ' years ago';
            }
            
            var subtitleParts = [];
            if (channel) subtitleParts.push(channel);
            if (views) subtitleParts.push(views);
            if (dateStr) subtitleParts.push(dateStr);
            var subtitle = subtitleParts.join(' • ');

            var html = `
            <div class="embed-list-item" data-platform="${(item.platform_name || '').toLowerCase()}" style="display:flex; justify-content:space-between; align-items:flex-start; padding: 12px; background: var(--atl-card); border-radius: 8px; margin-bottom: 12px; border: 1px solid var(--atl-line); transition: background 0.2s;">
                <div style="display:flex; gap:16px; align-items:flex-start; flex: 1; overflow: hidden;">
                    <div style="position:relative; width: 180px; height: 101px; flex-shrink: 0; background: #000; border-radius: 8px; overflow: hidden;">
                        <img src="${safeThumb}" onerror="this.src='data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';" alt="Thumbnail" style="width:100%; height:100%; object-fit: cover;">
                        ${(meta && meta.duration && meta.duration !== "0:00") ? `<div style="position:absolute; bottom:4px; right:4px; background:rgba(0,0,0,0.8); color: var(--atl-ink); font-size:11px; padding:2px 4px; border-radius:4px; font-weight:bold;">${meta.duration}</div>` : ''}
                    </div>
                    <div style="display: flex; flex-direction: column; justify-content: flex-start; flex: 1; padding-top: 2px;">
                        <strong style="font-size: 15px; color: var(--atl-ink); margin-bottom: 6px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; line-height: 1.3;">${title}</strong>
                        <small style="color:var(--atl-muted); font-size: 13px;">${subtitle}</small>
                        <span class="atl-badge ${active ? 'atl-badge--confirmed' : 'atl-badge--unpaid'}" style="margin-top:8px; align-self:flex-start;">${active ? 'Active' : 'Inactive'}</span>
                    </div>
                </div>
                <div style="display:flex; flex-direction:column; align-items:flex-end; gap:6px; flex-shrink:0; padding-left: 15px;">
                    <button type="button" class="atl-btn atl-btn--ghost um-btn--sm edit-embed-action" data-id="${item.id}" data-index="${index}" title="Edit ${title}" aria-label="Edit ${title}">
                        <i class="fa-solid fa-pen"></i>
                    </button>
                    <button type="button" class="um-btn um-btn--danger um-btn--sm remove-embed-action" data-id="${item.id}" title="Delete ${title}" aria-label="Delete ${title}">
                        <i class="fa-solid fa-trash-can"></i>
                    </button>
                </div>
            </div>`;
            $list.append(html);
        });
    } catch (err) {
        console.error("Failed to load embeds:", err);
        if (window.notificationService) window.notificationService.showError('Could not load media embeds. Please refresh.');
    }
}

$(document).on('change', '#embedPlatform', function() {
    var p = $(this).val();
    var $preview = $('#embedIconPreviewDisplay');
    if (p) {
        var iconClass = platformIconMap[p] || 'fa-solid fa-link';
        $preview.html('<i class="' + iconClass + '"></i>');

        $('#apiKeyGroup').show();
        var savedKey = localStorage.getItem('tm_api_key_' + p);
        if (savedKey) $('#platformApiKey').val(savedKey);
        else $('#platformApiKey').val('');
        
        if (p === 'Facebook') {
            $('#fbTokenGenerator').show();
        } else {
            $('#fbTokenGenerator').hide();
        }
    } else {
        $preview.empty();
        $('#apiKeyGroup').hide();
        $('#fbTokenGenerator').hide();
    }
});

$(document).on('click', '#generateFbTokenBtn', function() {
    var appId = $('#fbAppId').val().trim();
    var appSecret = $('#fbAppSecret').val().trim();
    if (appId && appSecret) {
        var token = appId + '|' + appSecret;
        $('#platformApiKey').val(token);
        window.notificationService.showSuccess("Facebook Access Token generated and applied to the API Key field!");
        $('#fbAppId').val('');
        $('#fbAppSecret').val('');
    } else {
        window.notificationService.showError("Please enter both your Meta App ID and App Secret to generate the token.");
    }
});

// Open the Media Embed drawer in create ("Add") mode.
window.openSocialEmbedDrawer = function() {
    $('#socialEmbedForm')[0].reset();
    $('#socialEmbedForm').removeData('editing-id');
    $('#embedPlatform').trigger('change');
    $('#embedActive').prop('checked', true);
    $('#embedActiveLabel').text('Active (visible on site)');
    $('#socialEmbedSaveBtn').html('<i class="fa-solid fa-plus-circle"></i> Add Media Embed').removeClass('btn-admin-success').addClass('btn-admin-primary');
    $('#socialEmbedDrawerTitle').html('<i class="fa-solid fa-code"></i> Add Media Embed');
    openAtlDrawer('socialEmbedDrawer');
};

$(document).on('submit', '#socialEmbedForm', function(e) {
    e.preventDefault();
    var platform = $('#embedPlatform').val();
    var url = $('#embedUrlCode').val().trim();
    if (!platform || !url) return;
    var expectedDomains = {
        "YouTube": ["youtube.com", "youtu.be"],
        "Vimeo": ["vimeo.com"],
        "Facebook": ["facebook.com", "fb.watch"],
        "Instagram": ["instagram.com"],
        "TikTok": ["tiktok.com"],
        "X (Twitter)": ["twitter.com", "x.com"],
        "Twitch": ["twitch.tv"],
        "Dailymotion": ["dailymotion.com", "dai.ly"],
        "LinkedIn": ["linkedin.com"]
    };
    if (expectedDomains[platform]) {
        var valid = false;
        expectedDomains[platform].forEach(function(d) {
            if (url.includes(d)) valid = true;
        });
        if (!valid) {
            window.notificationService.showError("Validation Error: This URL/Embed code does not appear to belong to " + platform + ". Please check your input.");
            return;
        }
    }

    var $btn = $('#socialEmbedSaveBtn');
    var apiKey = $('#platformApiKey').val().trim();
    if (apiKey) {
        localStorage.setItem('tm_api_key_' + platform, apiKey);
    } else {
        localStorage.removeItem('tm_api_key_' + platform);
    }

    var editingId = $('#socialEmbedForm').data('editing-id');

    async function finishSave(itemObj) {
        try {
            await apiCall('/api/admin/social_embeds', 'POST', {
                id: editingId || null,
                platform_name: itemObj.platform,
                embed_code: itemObj.url,
                metadata: itemObj.metadata,
                platform_api_key: apiKey || '',
                is_active: $('#embedActive').is(':checked')
            });

            $('#socialEmbedForm')[0].reset();
            $('#socialEmbedForm').removeData('editing-id');
            $('#apiKeyGroup').hide();
            $('#embedActiveLabel').text('Active (visible on site)');
            renderEmbedList();
            closeAtlDrawer('socialEmbedDrawer');
            window.notificationService.showSuccess(editingId ? 'Media embed updated.' : 'Media embed added.');
            $btn.html('<i class="fa-solid fa-plus-circle"></i> Add Media Embed').removeClass('btn-admin-success').addClass('btn-admin-primary').prop('disabled', false);
        } catch(err) {
            window.notificationService.showError('Error saving embed');
            $btn.text('Add Media Embed').prop('disabled', false);
        }
    }

    function generateMockMetadata(platform, url, titleOverride) {
        var thumb = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
        if (platform === 'YouTube') {
            var ytId = (url || '').match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([\w-]{11})/);
            if (ytId && ytId[1]) thumb = 'https://img.youtube.com/vi/' + ytId[1] + '/hqdefault.jpg';
        }
        return {
            videoId: "",
            title: titleOverride || platform + " Video",
            description: "Embedded media from " + platform + ".",
            tags: [platform],
            channelName: platform + " User",
            publishDate: new Date().toISOString(),
            thumbnail: thumb,
            viewCount: 0,
            likeCount: 0,
            commentCount: 0,
            duration: "0:00",
            categoryId: "",
            channelId: ""
        };
    }

    function fetchNoEmbedFallback(videoId, platform, url) {
        var cleanUrl = url;
        if (platform === 'YouTube' && videoId) {
            cleanUrl = "https://www.youtube.com/watch?v=" + videoId;
        } else {
            var srcMatch = url.match(/src="([^"]+)"/);
            if (srcMatch && !srcMatch[1].includes('facebook.com/plugins')) cleanUrl = srcMatch[1];
            var citeMatch = url.match(/cite="([^"]+)"/);
            if (citeMatch) cleanUrl = citeMatch[1];
            
            if (cleanUrl.includes('player.vimeo.com/video/')) cleanUrl = cleanUrl.replace('player.vimeo.com/video/', 'vimeo.com/');
            if (cleanUrl.includes('dailymotion.com/embed/video/')) cleanUrl = cleanUrl.replace('dailymotion.com/embed/video/', 'dailymotion.com/video/');
            if (cleanUrl.includes('player.twitch.tv/?video=')) cleanUrl = cleanUrl.replace('player.twitch.tv/?video=', 'twitch.tv/videos/');
        }

        fetch(`https://noembed.com/embed?url=${encodeURIComponent(cleanUrl)}`)
            .then(res => res.json())
            .then(noData => {
                var meta = generateMockMetadata(platform, url, noData.title || "");
                if (!noData.error) {
                    meta.title = noData.title || meta.title;
                    meta.channelName = noData.author_name || meta.channelName;
                    meta.thumbnail = noData.thumbnail_url || meta.thumbnail;
                } else if (platform === 'YouTube' && videoId) {
                    meta.thumbnail = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
                }
                finishSave({ platform: platform, url: url, metadata: meta });
            })
            .catch(err => {
                var meta = generateMockMetadata(platform, url);
                if (platform === 'YouTube' && videoId) {
                    meta.thumbnail = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
                }
                finishSave({ platform: platform, url: url, metadata: meta });
            });
    }

    function fetchMicrolinkFallback(platform, cleanUrl, originalUrl) {
        $('#socialEmbedSaveBtn').prop('disabled', true).text('Fetching Metadata...');
        fetch(`https://api.microlink.io?url=${encodeURIComponent(cleanUrl)}`)
            .then(res => res.json())
            .then(mlData => {
                var meta = generateMockMetadata(platform, originalUrl, mlData.data ? mlData.data.title : "");
                if (mlData.status === 'success' && mlData.data) {
                    meta.title = mlData.data.title || meta.title;
                    meta.description = mlData.data.description || meta.description;
                    meta.channelName = mlData.data.publisher || mlData.data.author || meta.channelName;
                    meta.thumbnail = mlData.data.image ? mlData.data.image.url : (mlData.data.logo ? mlData.data.logo.url : meta.thumbnail);
                    meta.publishDate = mlData.data.date || meta.publishDate;
                    if(platform === 'Facebook' && !mlData.data.image) meta.thumbnail = "https://upload.wikimedia.org/wikipedia/commons/thumb/0/05/Facebook_Logo_%282019%29.png/1024px-Facebook_Logo_%282019%29.png";
                    if(platform === 'TikTok' && !mlData.data.image && !mlData.data.logo) meta.thumbnail = "https://cdn-icons-png.flaticon.com/512/3046/3046122.png";
                    if(platform === 'Instagram' && !mlData.data.image && !mlData.data.logo) meta.thumbnail = "https://cdn-icons-png.flaticon.com/512/174/174855.png";
                }
                finishSave({ platform: platform, url: originalUrl, metadata: meta });
            }).catch(err => fetchNoEmbedFallback("", platform, originalUrl));
    }

    if (platform === 'YouTube') {
        var videoIdMatch = url.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([\w-]{11})/);
        if (videoIdMatch && videoIdMatch[1]) {
            var videoId = videoIdMatch[1];
            $btn.prop('disabled', true).text('Fetching Metadata...');
            if (apiKey) {
                fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails&id=${videoId}&key=${apiKey}`)
                    .then(response => {
                        if (!response.ok) throw new Error('API Error');
                        return response.json();
                    })
                    .then(ytData => {
                        if (ytData.items && ytData.items.length > 0) {
                            var item = ytData.items[0];
                            var metadata = {
                                videoId: videoId,
                                title: item.snippet.title,
                                description: item.snippet.description,
                                tags: item.snippet.tags || [],
                                channelName: item.snippet.channelTitle,
                                publishDate: item.snippet.publishedAt,
                                thumbnail: item.snippet.thumbnails.high ? item.snippet.thumbnails.high.url : item.snippet.thumbnails.default.url,
                                viewCount: item.statistics.viewCount || 0,
                                likeCount: item.statistics.likeCount || 0,
                                commentCount: item.statistics.commentCount || 0
                            };
                            finishSave({ platform: platform, url: url, metadata: metadata });
                        } else {
                            fetchNoEmbedFallback(videoId, platform, url);
                        }
                    }).catch(err => fetchNoEmbedFallback(videoId, platform, url));
            } else fetchNoEmbedFallback(videoId, platform, url);
        } else finishSave({ platform: platform, url: url, metadata: generateMockMetadata(platform, url) });
    } else if (platform === 'Vimeo') {
        var vMatch = url.match(/vimeo\.com\/(?:video\/|)(\d+)/);
        if (vMatch && vMatch[1]) {
            var vId = vMatch[1];
            $btn.prop('disabled', true).text('Fetching Metadata...');
            if (apiKey) {
                fetch(`https://api.vimeo.com/videos/${vId}`, { headers: {"Authorization": "Bearer " + apiKey} })
                    .then(res => {
                        if (!res.ok) throw new Error('API Error');
                        return res.json();
                    })
                    .then(vData => {
                        var metadata = {
                            videoId: vId,
                            title: vData.name,
                            description: vData.description || "",
                            tags: vData.tags ? vData.tags.map(t=>t.name) : [],
                            channelName: vData.user ? vData.user.name : "Vimeo User",
                            publishDate: vData.created_time,
                            thumbnail: vData.pictures && vData.pictures.sizes && vData.pictures.sizes.length > 0 ? vData.pictures.sizes[vData.pictures.sizes.length-1].link : "",
                            viewCount: vData.stats ? vData.stats.plays || 0 : 0,
                            likeCount: vData.metadata && vData.metadata.connections && vData.metadata.connections.likes ? vData.metadata.connections.likes.total : 0,
                            commentCount: vData.metadata && vData.metadata.connections && vData.metadata.connections.comments ? vData.metadata.connections.comments.total : 0
                        };
                        finishSave({ platform: platform, url: url, metadata: metadata });
                    }).catch(err => fetchNoEmbedFallback(vId, platform, url));
            } else fetchNoEmbedFallback(vId, platform, url);
        } else finishSave({ platform: platform, url: url, metadata: generateMockMetadata(platform, url) });
    } else if (platform === 'Instagram') {
        var cleanUrl = url;
        var permalinkMatch = url.match(/data-instgrm-permalink="([^"]+)"/);
        if (permalinkMatch) {
            cleanUrl = permalinkMatch[1];
        } else {
            var httpMatch = url.match(/(https?:\/\/www\.instagram\.com\/(?:p|reel|tv)\/[^\s"']+)/);
            if (httpMatch) cleanUrl = httpMatch[1];
        }
        // Strip query parameters
        if (cleanUrl.includes('?')) cleanUrl = cleanUrl.split('?')[0];
        
        fetchMicrolinkFallback(platform, cleanUrl, url);
    } else if (platform === 'Facebook') {
        var cleanUrl = url;
        var srcMatch = url.match(/src="([^"]+)"/);
        if (srcMatch && srcMatch[1].includes('facebook.com/plugins')) {
            var tempUrl = new URL(srcMatch[1].replace(/&amp;/g, '&'));
            if (tempUrl.searchParams.has('href')) cleanUrl = tempUrl.searchParams.get('href');
        } else if (srcMatch) cleanUrl = srcMatch[1];
        
        var fbIdMatch = cleanUrl.match(/\/videos\/(\d+)/) || cleanUrl.match(/\/reel\/(\d+)/) || cleanUrl.match(/v=(\d+)/) || cleanUrl.match(/watch\/\?v=(\d+)/);
        if (fbIdMatch && fbIdMatch[1]) {
            var fbId = fbIdMatch[1];
            $btn.prop('disabled', true).text('Fetching Metadata...');
            if (apiKey) {
                fetch(`https://graph.facebook.com/v19.0/${fbId}?fields=title,description,created_time,thumbnails,views,likes.summary(true),comments.summary(true)&access_token=${apiKey}`)
                    .then(res => {
                        if (!res.ok) throw new Error('API Error');
                        return res.json();
                    })
                    .then(fbData => {
                        var metadata = {
                            videoId: fbId,
                            title: fbData.title || fbData.description || "Facebook Video",
                            description: fbData.description || "",
                            tags: [],
                            channelName: "Facebook User",
                            publishDate: fbData.created_time || new Date().toISOString(),
                            thumbnail: fbData.thumbnails && fbData.thumbnails.data && fbData.thumbnails.data.length > 0 ? fbData.thumbnails.data[0].uri : "",
                            viewCount: fbData.views || 0,
                            likeCount: fbData.likes ? fbData.likes.summary.total_count : 0,
                            commentCount: fbData.comments ? fbData.comments.summary.total_count : 0
                        };
                        finishSave({ platform: platform, url: url, metadata: metadata });
                    }).catch(err => fetchMicrolinkFallback(platform, cleanUrl, url));
            } else fetchMicrolinkFallback(platform, cleanUrl, url);
        } else {
            fetchMicrolinkFallback(platform, cleanUrl, url);
        }
    } else if (platform === 'TikTok') {
        var cleanUrl = url;
        var citeMatch = url.match(/cite="([^"]+)"/);
        if (citeMatch) cleanUrl = citeMatch[1];
        
        $btn.prop('disabled', true).text('Fetching Metadata...');
        fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(cleanUrl)}`)
            .then(res => res.json())
            .then(tkData => {
                var meta = generateMockMetadata(platform, url, tkData.title || "TikTok Video");
                meta.channelName = tkData.author_name || meta.channelName;
                meta.thumbnail = tkData.thumbnail_url || meta.thumbnail;
                finishSave({ platform: platform, url: url, metadata: meta });
            }).catch(err => {
                finishSave({ platform: platform, url: url, metadata: generateMockMetadata(platform, url) });
            });
    } else {
        fetchNoEmbedFallback("", platform, url);
    }
});

$(document).on('click', '.remove-embed-action', async function(e) {
    e.preventDefault();
    if (await window.notificationService.showConfirm({ message: 'Are you sure you want to permanently delete this embed?', isDestructive: true })) {
        var id = $(this).data('id');
        try {
            const result = await apiCall('/api/admin/social_embeds/' + id, 'DELETE');
            if (result && !result.error) {
                $('#socialEmbedForm').removeData('editing-id');
                $('#socialEmbedSaveBtn').text('Add Media Embed').removeClass('btn-admin-success').addClass('btn-admin-primary');
                renderEmbedList();
            }
        } catch(err) {
            console.error('Delete failed:', err);
            if (window.notificationService) window.notificationService.showError('Could not delete the media embed. Please try again.');
        }
    }
});

$(document).on('click', '.edit-embed-action', function(e) {
    e.preventDefault();
    var index = $(this).data('index');
    var item = globalEmbedData[index];
    
    $('#embedPlatform').val(item.platform_name).trigger('change');
    if (item.platform_api_key) {
        $('#platformApiKey').val(item.platform_api_key);
    }
    $('#embedUrlCode').val(item.embed_code);
    $('#socialEmbedForm').data('editing-id', item.id);
    $('#embedActive').prop('checked', item.is_active != 0);
    $('#embedActiveLabel').text(item.is_active != 0 ? 'Active (visible on site)' : 'Inactive (hidden)');

    $('#socialEmbedSaveBtn').html('<i class="fa-solid fa-floppy-disk"></i> Update Media Embed').removeClass('btn-admin-primary').addClass('btn-admin-success');
    $('#socialEmbedDrawerTitle').html('<i class="fa-solid fa-code"></i> Edit Media Embed');
    openAtlDrawer('socialEmbedDrawer');
    $('#embedUrlCode').focus();
});

function loadSocialData() {
    renderEmbedList();
    renderSocialList();
    loadSocialKpiSettings();
}
window.loadSocialData = loadSocialData;

function loadSocialKpiSettings() {
    fetch('/api/admin/dashboard/social_kpis', { credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) {
            if (!data || !data.success || !data.kpis) return;
            const container = $('#kpiSettingsContainer');
            container.empty();

            const meta = {
                'Facebook':    { key: 'fb', icon: 'fa-brands fa-facebook' },
                'Instagram':   { key: 'ig', icon: 'fa-brands fa-instagram' },
                'X (Twitter)': { key: 'x',  icon: 'fa-brands fa-x-twitter' },
                'YouTube':     { key: 'yt', icon: 'fa-brands fa-youtube' },
                'TikTok':      { key: 'tt', icon: 'fa-brands fa-tiktok' }
            };

            // Wrap a secret input with a show/hide reveal button.
            function secret(cls, value, placeholder) {
                return `
                    <div class="kpi-input-wrap">
                        <input type="password" class="atl-input ${cls}" value="${value || ''}" style="width:100%; font-family:monospace;" placeholder="${placeholder}">
                        <button type="button" class="kpi-eye" aria-label="Show or hide value"><i class="fa-regular fa-eye"></i></button>
                    </div>`;
            }

            const creds = data.credentials || {};

            data.kpis.forEach(function (kpi) {
                const m = meta[kpi.platform_name] || { key: '', icon: 'fa-solid fa-link' };
                const isManual = kpi.manual_override === 1;

                let apiFieldsHtml = '';
                if (kpi.platform_name === 'YouTube') {
                    apiFieldsHtml = `
                        <div class="kpi-api-fields" style="${isManual ? 'display:none;' : ''} margin-top:12px;">
                            <div class="um-field-group" style="margin-bottom:8px;">
                                <label class="um-label">YouTube API Key</label>
                                ${secret('kpi-yt-key', creds.youtube_api_key, 'AIzaSy...')}
                            </div>
                            <div class="um-field-group">
                                <label class="um-label">YouTube Channel ID</label>
                                <input type="text" class="atl-input kpi-yt-channel" value="${creds.youtube_channel_id || ''}" style="width:100%;" placeholder="UC...">
                            </div>
                        </div>
                    `;
                } else if (kpi.platform_name === 'Facebook') {
                    apiFieldsHtml = `
                        <div class="kpi-api-fields" style="${isManual ? 'display:none;' : ''} margin-top:12px;">
                            <div class="um-field-group" style="margin-bottom:8px;">
                                <label class="um-label">Facebook Page Access Token</label>
                                ${secret('kpi-fb-token', creds.facebook_page_access_token, 'EAA...')}
                            </div>
                            <div class="um-field-group">
                                <label class="um-label">Facebook Page ID</label>
                                <input type="text" class="atl-input kpi-fb-id" value="${creds.facebook_page_id || ''}" style="width:100%;" placeholder="Page ID...">
                            </div>
                        </div>
                    `;
                } else if (kpi.platform_name === 'Instagram') {
                    apiFieldsHtml = `
                        <div class="kpi-api-fields" style="${isManual ? 'display:none;' : ''} margin-top:12px;">
                            <div class="um-field-group" style="margin-bottom:8px;">
                                <label class="um-label">Instagram Access Token</label>
                                ${secret('kpi-ig-token', creds.instagram_access_token, 'IGQV...')}
                            </div>
                            <div class="um-field-group">
                                <label class="um-label">Instagram User ID</label>
                                <input type="text" class="atl-input kpi-ig-id" value="${creds.instagram_user_id || ''}" style="width:100%;" placeholder="User/Page ID...">
                            </div>
                        </div>
                    `;
                } else if (kpi.platform_name === 'X (Twitter)') {
                    apiFieldsHtml = `
                        <div class="kpi-api-fields" style="${isManual ? 'display:none;' : ''} margin-top:12px;">
                            <div class="um-field-group" style="margin-bottom:8px;">
                                <label class="um-label">Twitter Bearer Token</label>
                                ${secret('kpi-tw-token', creds.twitter_bearer_token, 'AAAAAAAAAAAAAAAAAAAA...')}
                            </div>
                            <div class="um-field-group">
                                <label class="um-label">Twitter Username</label>
                                <input type="text" class="atl-input kpi-tw-username" value="${creds.twitter_username || ''}" style="width:100%;" placeholder="username">
                            </div>
                        </div>
                    `;
                } else if (kpi.platform_name === 'TikTok') {
                    apiFieldsHtml = `
                        <div class="kpi-api-fields" style="${isManual ? 'display:none;' : ''} margin-top:12px;">
                            <div class="um-field-group">
                                <label class="um-label">TikTok Access Token</label>
                                ${secret('kpi-tt-token', creds.tiktok_access_token, 'act.example...')}
                            </div>
                        </div>
                    `;
                }

                const card = `
                    <div class="kpi-cfg-card" data-platform-key="${m.key}">
                        <div class="kpi-cfg-head">
                            <i class="kpi-cfg-icon ${m.icon}"></i>
                            <span class="kpi-cfg-title">${kpi.platform_name}</span>
                            <span class="kpi-cfg-chip ${isManual ? 'kpi-cfg-chip--manual' : 'kpi-cfg-chip--live'}">${isManual ? 'Manual' : 'Live'}</span>
                        </div>

                        <div class="um-field-group" style="margin-bottom:14px;">
                            <label class="um-label">Data Source</label>
                            <div class="kpi-seg" data-platform="${kpi.platform_name}">
                                <button type="button" class="kpi-seg-btn kpi-source-btn ${isManual ? 'active' : ''}" data-value="1" onclick="toggleKpiFields(this)"><i class="fa-solid fa-pen-to-square"></i> Manual</button>
                                <button type="button" class="kpi-seg-btn kpi-source-btn ${isManual ? '' : 'active'}" data-value="0" onclick="toggleKpiFields(this)"><i class="fa-solid fa-bolt"></i> Live API</button>
                            </div>
                        </div>

                        <div class="kpi-manual-fields" style="${isManual ? '' : 'display:none;'}">
                            <div class="kpi-cfg-row" style="margin-bottom:10px;">
                                <div class="um-field-group" style="margin-bottom:0;">
                                    <label class="um-label">Follower Count</label>
                                    <input type="number" class="atl-input kpi-count-input" data-platform="${kpi.platform_name}" value="${kpi.follower_count}" min="0" style="width:100%;">
                                </div>
                                <div class="um-field-group" style="margin-bottom:0;">
                                    <label class="um-label">Goal / Target</label>
                                    <input type="number" class="atl-input kpi-goal-input" data-platform="${kpi.platform_name}" value="${kpi.goal_target || 0}" min="0" style="width:100%;">
                                </div>
                            </div>
                            <div class="kpi-cfg-row">
                                <div class="um-field-group" style="margin-bottom:0;">
                                    <label class="um-label">Trend %</label>
                                    <input type="number" step="0.01" min="0" class="atl-input kpi-trend-input" data-platform="${kpi.platform_name}" value="${Math.abs(kpi.trend_percentage)}" style="width:100%;">
                                </div>
                                <div class="um-field-group" style="margin-bottom:0;">
                                    <label class="um-label">Direction</label>
                                    <select class="atl-input kpi-direction-select" data-platform="${kpi.platform_name}" style="width:100%;">
                                        <option value="up" ${kpi.trend_direction === 'up' ? 'selected' : ''}>Up (+)</option>
                                        <option value="down" ${kpi.trend_direction === 'down' ? 'selected' : ''}>Down (&minus;)</option>
                                    </select>
                                </div>
                            </div>
                        </div>

                        ${apiFieldsHtml}
                    </div>
                `;
                container.append(card);
            });
        })
        .catch(function (e) {
            console.error('Failed to load social KPI settings', e);
        });
}

window.toggleKpiFields = function (btn) {
    const card = $(btn).closest('.kpi-cfg-card');
    const isManual = $(btn).attr('data-value') === '1';

    // Activate the clicked segment
    card.find('.kpi-source-btn').removeClass('active');
    $(btn).addClass('active');

    // Toggle the relevant field groups
    if (isManual) {
        card.find('.kpi-manual-fields').show();
        card.find('.kpi-api-fields').hide();
    } else {
        card.find('.kpi-manual-fields').hide();
        card.find('.kpi-api-fields').show();
    }

    // Reflect the active mode in the status chip
    card.find('.kpi-cfg-chip')
        .toggleClass('kpi-cfg-chip--manual', isManual)
        .toggleClass('kpi-cfg-chip--live', !isManual)
        .text(isManual ? 'Manual' : 'Live');
};

// Delegated show/hide reveal for dynamically-injected KPI credential fields
$(document).on('click', '.kpi-eye', function () {
    const inp = $(this).closest('.kpi-input-wrap').find('input')[0];
    if (!inp) return;
    const isPass = inp.type === 'password';
    inp.type = isPass ? 'text' : 'password';
    const icon = this.querySelector('i');
    if (icon) icon.className = isPass ? 'fa-regular fa-eye-slash' : 'fa-regular fa-eye';
});

window.saveSocialKpiSettings = async function () {
    const btn = $('#saveKpiSettingsBtn');
    const originalHtml = btn.html();
    btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> Saving...');
    
    // Save API credentials if they are defined in the UI
    const credentialsToSave = {};
    const ytKeyInput = $('.kpi-yt-key');
    if (ytKeyInput.length > 0) {
        credentialsToSave.youtube_api_key = ytKeyInput.val().trim();
        credentialsToSave.youtube_channel_id = $('.kpi-yt-channel').val().trim();
    }
    const fbTokenInput = $('.kpi-fb-token');
    if (fbTokenInput.length > 0) {
        credentialsToSave.facebook_page_access_token = fbTokenInput.val().trim();
        credentialsToSave.facebook_page_id = $('.kpi-fb-id').val().trim();
    }
    const igTokenInput = $('.kpi-ig-token');
    if (igTokenInput.length > 0) {
        credentialsToSave.instagram_access_token = igTokenInput.val().trim();
        credentialsToSave.instagram_user_id = $('.kpi-ig-id').val().trim();
    }
    const twTokenInput = $('.kpi-tw-token');
    if (twTokenInput.length > 0) {
        credentialsToSave.twitter_bearer_token = twTokenInput.val().trim();
        credentialsToSave.twitter_username = $('.kpi-tw-username').val().trim();
    }
    const ttTokenInput = $('.kpi-tt-token');
    if (ttTokenInput.length > 0) {
        credentialsToSave.tiktok_access_token = ttTokenInput.val().trim();
    }

    if (Object.keys(credentialsToSave).length > 0) {
        try {
            await apiCall('/api/admin/settings', 'PUT', { settings: credentialsToSave });
        } catch (e) {
            console.error('Failed to save API credentials:', e);
        }
    }

    const platforms = ['Facebook', 'Instagram', 'X (Twitter)', 'YouTube', 'TikTok'];
    let errorCount = 0;

    for (const platform of platforms) {
        const seg = $(`.kpi-seg[data-platform="${platform}"]`);
        if (seg.length === 0) continue;

        const card = seg.closest('.kpi-cfg-card');
        const manual_override = parseInt(seg.find('.kpi-source-btn.active').attr('data-value')) || 0;
        const follower_count = parseInt(card.find('.kpi-count-input').val()) || 0;
        const goal_target = parseInt(card.find('.kpi-goal-input').val()) || 0;
        const trend_percentage = Math.abs(parseFloat(card.find('.kpi-trend-input').val()) || 0);
        const trend_direction = card.find('.kpi-direction-select').val() || 'up';

        try {
            const res = await apiCall('/api/admin/dashboard/social_kpis', 'POST', {
                platform_name: platform,
                manual_override: manual_override,
                follower_count: follower_count,
                goal_target: goal_target,
                trend_percentage: trend_percentage,
                trend_direction: trend_direction
            });
            if (!res || !res.success) errorCount++;
        } catch (e) {
            console.error('Error saving ' + platform + ' KPI', e);
            errorCount++;
        }
    }

    btn.prop('disabled', false).html(originalHtml);
    if (errorCount === 0) {
        if (window.notificationService) {
            window.notificationService.showSuccess("Social Media KPI configurations saved successfully!");
        } else {
            alert("Social Media KPI configurations saved successfully!");
        }
        loadAnalyticsDashboard();
        loadSocialKpiSettings();
    } else {
        if (window.notificationService) {
            window.notificationService.showError("Some platform settings failed to update. Please check console.");
        } else {
            alert("Some platform settings failed to update.");
        }
    }
};
