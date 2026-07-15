$(function() {
    "use strict";

    // --- ADMIN PAGE ISOLATION ---
    // If we're on the admin portal, skip public-site specific heavy logic (Slider/Carousel/Observers)
    // to prevent renderer crashes and layout loops.
    if (window.location.pathname.includes('admin.html')) {
        console.log("Admin Portal detected — Isolating main site scripts to prevent conflicts.");
        
        // Only run minimal essential common logic if any (currently none)
        return; 
    }

    // --- DYNAMIC HOME SLIDER ---
    // The home slider content is now primarily managed via the "Publish" mechanism 
    // in the admin portal which updates index.html directly for performance.
    // ----------------------------

    var topoffset = 50; //variable for menu height
    var slideqty = $('#featured .item').length;
    var wheight = $(window).height(); //get the height of the window
    var randSlide = Math.floor(Math.random()*slideqty);
    
    


    $('#featured .item').eq(randSlide).addClass('active');

    // $('.fullheight').css('height', wheight); //set to window tallness (Disabled to prevent layout loops)

    //replace IMG inside carousels with a background image
    $('#featured .item img').each(function() {
        var imgSrc = $(this).attr('src');
        $(this).parent().css({'background-image': 'url('+imgSrc+')'});
        $(this).remove();
    });

    //adjust height of .fullheight elements on window resize
    $(window).resize(function() {
        wheight = $(window).height(); //get the height of the window
        // $('.fullheight').css('height', wheight); //set to window tallness (Disabled to prevent layout loops)
    });

    //Activate Scrollspy
    $('body').scrollspy({
        target: 'header .navbar',
        offset: topoffset
    });

    // add inbody class
    var hash = $(this).find('li.active a').attr('href');
    if(hash !== '#featured') {
        $('header nav').addClass('inbody');
    } else {
        $('header nav').removeClass('inbody');
    }

    // Add an inbody class to nav when scrollspy event fires
    $('.navbar-fixed-top').on('activate.bs.scrollspy', function() {
        var hash = $(this).find('li.active a').attr('href');
        if(hash !== '#featured') {
            $('header nav').addClass('inbody');
        } else {
            $('header nav').removeClass('inbody');
        }
    });

    //Use smooth scrolling when clicking on navigation
    $('.navbar a[href*=#]:not([href=#])').click(function() {
        if (location.pathname.replace(/^\//,'') ===
            this.pathname.replace(/^\//,'') &&
            location.hostname === this.hostname) {
            var target = $(this.hash);
            target = target.length ? target : $('[name=' + this.hash.slice(1) +']');
            if (target.length) {
                $('html,body').animate({
                    scrollTop: target.offset().top-topoffset+2
                }, 500);
                return false;
            } //target.length
        } //click function
    }); //smooth scrolling

    //Automatically generate carousel indicators
    for (var i=0; i < slideqty; i++) {
        var insertText = '<li data-target="#featured" data-slide-to="' + i + '"';
        if (i === randSlide) {
            insertText += ' class="active" ';
        }
        insertText += '></li>';
        $('#featured ol').append(insertText);
    }



    $('.carousel').carousel({
        interval: 6000,
        pause: false
    });

    // --- NEW JAVASCRIPT FEATURES ---

    // 1. Dynamic Copyright Year
    var currentYear = new Date().getFullYear();
    $('#current-year').text(currentYear);

    // 2. Back to Top Button
    var btn = $('#back-to-top');
    $(window).scroll(function() {
        if ($(window).scrollTop() > 300) {
            btn.addClass('show');
        } else {
            btn.removeClass('show');
        }
    });

    btn.on('click', function(e) {
        e.preventDefault();
        $('html, body').animate({scrollTop:0}, '300');
    });

    // 3. Form Validation and Submission (Nodemailer Backend)
    $('#contactForm').on('submit', async function(e) {
        e.preventDefault();
        
        var $btn = $(this).find('button[type="submit"]');
        var originalBtnHtml = $btn.html();

        // Helper function for showing validation alerts
        function showValidationAlert(msg) {
            window.notificationService.showError(msg);
        }

        // --- Execute Field Validations ---
        var name = $('#contactName').val().trim();
        if (name.length < 2) {
            return showValidationAlert('Please enter your full name (minimum 2 characters).');
        }

        var em = $('#contactEmail').val().trim();
        var re = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
        if (!re.test(em)) {
            return showValidationAlert('Please enter a valid email address.');
        }

        if (window.itiContact) {
            var cellVal = $('#contactCell').val().trim();
            if (cellVal === '') {
                return showValidationAlert('Please enter your cellphone number.');
            }
            var rawVal = cellVal.replace(/\D/g, '');
            var isStrictValid = window.itiContact.isValidNumber();
            
            if (!isStrictValid && (rawVal.length < 10 || rawVal.length > 15)) {
                return showValidationAlert('Please enter a valid cellphone number. It must be 10 to 15 digits long. Make sure you selected the correct country code (e.g. +27).');
            }
        }

        var category = $('#contactCategory').val();
        if (!category) {
            return showValidationAlert('Please select an inquiry category from the dropdown.');
        }

        var message = $('#contactMessage').val().trim();
        if (message.length < 10) {
            return showValidationAlert('Your message is too short. Please provide more details (minimum 10 characters).');
        }

        $btn.prop('disabled', true).html('<i class="fa fa-spinner fa-spin" style="margin-right:8px;"></i>Sending...');

        // Fetch config to check if an override delivery email was saved by the admin
        var adminEmail = 'thabiso@example.com'; 
        var contactData = localStorage.getItem('tm_contact_data');
        if (contactData) {
            var parsed = JSON.parse(contactData);
            if (parsed.email) adminEmail = parsed.email;
        }

        var payload = {
            name: $('#contactName').val().trim(),
            email: em,
            cell: window.itiContact ? window.itiContact.getNumber() : '',
            category: $('#contactCategory').val() || 'General Inquiry',
            subject: $('#contactSubject').val().trim(),
            message: $('#contactMessage').val().trim(),
            recipientEmail: adminEmail,
            popia_consent: $('#contactPopia').is(':checked')
        };

        try {
            const response = await fetch('/send-email', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const result = await response.json();
            
            if (result.success) {
                window.notificationService.showSuccess('Your message has been sent. Thank you for getting in touch.');
                this.reset();
            } else {
                throw new Error(result.message || 'Server rejected message.');
            }
        } catch (err) {
            console.error("Email Error:", err);
            window.notificationService.showError('Could not send email. Please try again later or contact us directly.');
        }

        // Restore button state
        $btn.prop('disabled', false).html(originalBtnHtml);
    });

    // 4. Scroll Reveal Animations (Intersection Observer)
    // First, add the .reveal class to elements we want to animate
    $('.sectionHeader, .page .row, .contact img, .tm-reveal').addClass('reveal');

    // Check if IntersectionObserver is supported
    if ('IntersectionObserver' in window) {
        var revealObserver = new IntersectionObserver(function(entries, observer) {
            entries.forEach(function(entry) {
                if (entry.isIntersecting) {
                    $(entry.target).addClass('active');
                    // Stop observing once revealed to prevent layout loops
                    observer.unobserve(entry.target);
                }
            });
        }, {
            root: null,
            threshold: 0.15 // Trigger when 15% of the element is visible
        });

        $('.reveal').each(function() {
            revealObserver.observe(this);
        });
    } else {
        // Fallback for older browsers
        $('.reveal').addClass('active');
    }

    // 5. Dynamic Gallery Rendering (Instagram Style)
    async function renderGallery() {
        var $grid = $('#dynamicGalleryGrid');
        if ($grid.length === 0) return; // Only run on pages with the grid

        var galleryItems = [];
        try {
            const response = await fetch('/api/public/gallery');
            const data = await response.json();
            if (Array.isArray(data)) {
                galleryItems = data;
            }
        } catch (err) {
            console.error("Failed to load gallery data from server:", err);
        }

        $grid.empty();
        
        if (galleryItems.length === 0) {
            $grid.append('<p class="text-center" style="width: 100%; color: #999;">The gallery is currently empty.</p>');
            return;
        }

        galleryItems.forEach(function(item) {
            var isVideo = false;
            var urlLower = item.image_path ? item.image_path.toLowerCase() : '';
            
            // Check if it's a Base64 video or has a video extension
            if (urlLower.startsWith('data:video') || urlLower.match(/\.(mp4|webm|ogg)$/)) {
                isVideo = true;
            }

            var mediaHtml = '';
            var safeAlt = item.title ? item.title.replace(/"/g, '&quot;') : '';
            if (isVideo) {
                mediaHtml = `<video src="${item.image_path}" muted autoplay loop playsinline onerror="this.outerHTML='<img src=\\'https://placehold.co/250x250/111/EEE?text=Video+Error\\'>'"></video>`;
            } else {
                mediaHtml = `<img src="${item.image_path}" alt="${safeAlt}" data-desc="${safeAlt}" loading="lazy" onerror="this.src='https://placehold.co/250x250/111/EEE?text=Image+Missing'">`;
            }

            var html = `
                <div class="insta-item reveal">
                    ${mediaHtml}
                </div>
            `;
            $grid.append(html);
        });

        // Re-trigger IntersectionObserver for newly added elements
        if ('IntersectionObserver' in window && typeof revealObserver !== 'undefined') {
            $('.insta-item.reveal').each(function() {
                revealObserver.observe(this);
            });
        }
    }

    // Call it on page load
    renderGallery();

    // 6. Dynamic About Me Rendering
    async function renderAboutMe() {
        try {
            var res = await fetch('/api/public/about-me', { cache: 'no-store' });
            if (!res.ok) return;
            var data = await res.json();
            if (data.image_path) $('.about-img').attr('src', data.image_path);
            var html = (data.paragraph1 || '') + (data.paragraph2 || '') + (data.paragraph3 || '');
            if (html.trim()) $('.about-text-card').html(html);
        } catch(e) {
            console.warn('Could not load About Me content:', e);
        }
    }
    renderAboutMe();

    // 6b. Dynamic homepage content — Hero paragraph + "What I Do" section (admin-editable).
    // Only overrides a field when the DB has a value for it, so the static markup is the fallback.

    // Admin-controlled public section visibility. `sel` = the section element; `nav` = hrefs of nav
    // links (desktop <li> + mobile <a>) to hide alongside it so nothing scrolls to a hidden section.
    // The Announcement bar is handled separately (it shares the announcement_enabled setting).
    var SECTION_MAP = {
        hero:       { sel: '#hero',        nav: ['#hero'] },
        features:   { sel: '.tm-features', nav: [] },
        services:   { sel: '.tm-services', nav: [] },
        about:      { sel: '#about',       nav: ['#about'] },
        career:     { sel: '#career',      nav: ['#career'] },
        footprint:  { sel: '#footprint',   nav: ['#footprint'] },
        gallery:    { sel: '#gallery',     nav: ['#gallery'] },
        events:     { sel: '#events',      nav: ['#events'] },
        social:     { sel: '#social',      nav: ['#social'] },
        newsletter: { sel: '#newsletter',  nav: ['#newsletter'] },
        testimonials: { sel: '#testimonials', nav: ['#testimonials'] },
        contact:    { sel: '#contact',     nav: ['#contact'] },
        footer:     { sel: '.tm-footer',   nav: [] }
    };

    function applySectionVisibility(sections) {
        sections = sections || {};
        Object.keys(SECTION_MAP).forEach(function (key) {
            var conf = SECTION_MAP[key];
            var visible = sections[key] !== false; // absent/true => visible
            $(conf.sel).toggleClass('tm-section-hidden', !visible);
            (conf.nav || []).forEach(function (href) {
                $('.tm-navlinks a[href="' + href + '"], .tm-mobile-menu a[href="' + href + '"]').each(function () {
                    var $li = $(this).closest('li');
                    ($li.length ? $li : $(this)).toggle(visible);
                });
            });
        });
        // Cache the authoritative map for the no-FOUC head script on the next load…
        try { localStorage.setItem('tm_sections', JSON.stringify(sections)); } catch (e) {}
        // …then drop the temporary head style so the .tm-section-hidden classes above are the only control.
        var tmp = document.querySelector('style[data-tm-sections]');
        if (tmp) tmp.parentNode.removeChild(tmp);
    }

    async function renderSiteContent() {
        try {
            var res = await fetch('/api/public/site-content', { cache: 'no-store' });
            if (!res.ok) return;
            var data = await res.json();
            if (!data || !data.success) return;
            var a = data.announcement || {};
            if (a.text && a.text.trim()) {
                var $am = $('.tm-announcement .tm-announce-marquee');
                if (!$am.length) { $('.tm-announcement').html('<div class="tm-announce-marquee"></div>'); $am = $('.tm-announcement .tm-announce-marquee'); }
                $am.html(a.text);
            }
            if (a.enabled === false) $('.tm-announcement').hide(); else $('.tm-announcement').show();
            if (a.rotate === false) $('.tm-announcement').addClass('no-rotate'); else $('.tm-announcement').removeClass('no-rotate');
            if (data.hero_tagline && data.hero_tagline.trim()) $('.tm-hero__tagline').text(data.hero_tagline);
            if (data.hero_subtitle && data.hero_subtitle.trim()) $('.tm-hero__subtitle').html(data.hero_subtitle);
            var s = data.services || {};
            if (s.eyebrow && s.eyebrow.trim()) $('.tm-services .tm-eyebrow').text(s.eyebrow);
            if (s.heading && s.heading.trim()) $('#servicesTitle').html(s.heading);
            if (Array.isArray(s.items) && s.items.length) {
                var $cards = $('.tm-services__grid .tm-service');
                s.items.forEach(function (item, i) {
                    var $c = $cards.eq(i);
                    if (!$c.length || !item) return;
                    if (item.title && String(item.title).trim()) $c.find('.tm-service__title').text(item.title);
                    if (item.description && String(item.description).trim()) $c.find('.tm-service__desc').text(item.description);
                    if (item.image && String(item.image).trim()) $c.find('.tm-service__bg').css('background-image', 'url("' + item.image + '")');
                });
            }
            var f = (data.features && Array.isArray(data.features.items)) ? data.features.items : [];
            if (f.length) {
                var $feat = $('.tm-features__grid .tm-feature');
                f.forEach(function (item, i) {
                    var $c = $feat.eq(i);
                    if (!$c.length || !item) return;
                    if (item.title && String(item.title).trim()) $c.find('.tm-feature__title').text(item.title);
                    if (item.description && String(item.description).trim()) $c.find('.tm-feature__desc').text(item.description);
                });
            }

            // Apply admin-controlled section visibility (hides sections + their nav links).
            applySectionVisibility(data.sections);
        } catch (e) {
            console.warn('Could not load site content:', e);
        }
    }
    renderSiteContent();


    // 8. Dynamic Events Rendering (API Driven)
    async function renderEvents() {
        var $upcomingGrid = $('#upcomingEventsGrid');
        var $pastGrid = $('#pastEventsGrid');
        
        if ($upcomingGrid.length === 0 && $pastGrid.length === 0) return;

        // Fetch from new API
        var eventsItems = [];
        try {
            let res = await fetch('/api/public/events');
            if (res.ok) {
                eventsItems = await res.json();
            }
        } catch (err) {
            console.error("Failed to fetch events:", err);
        }

        var now = new Date().getTime();

        var upcomingEvents = eventsItems.filter(function(item) {
            var d = new Date(item.event_datetime).getTime();
            return !item.event_datetime || isNaN(d) || d >= now;
        });
        upcomingEvents.sort(function(a, b) {
            var dateA = new Date(a.event_datetime).getTime();
            var dateB = new Date(b.event_datetime).getTime();
            if (isNaN(dateA)) dateA = Infinity; // push missing dates to end
            if (isNaN(dateB)) dateB = Infinity;
            return dateA - dateB;
        });

        var pastEvents = eventsItems.filter(function(item) {
            var d = new Date(item.event_datetime).getTime();
            return item.event_datetime && !isNaN(d) && d < now;
        });
        pastEvents.sort(function(a, b) {
            var dateA = new Date(a.event_datetime).getTime();
            var dateB = new Date(b.event_datetime).getTime();
            return dateB - dateA;
        });

        function populateGrid($grid, items, emptyMessage) {
            if ($grid.length === 0) return;
            $grid.empty();
            
            if (items.length === 0) {
                $grid.append('<p class="text-center" style="width: 100%; color: #999;">' + emptyMessage + '</p>');
                return;
            }

            items.forEach(function(item) {
                var displayDate = item.event_datetime;
                if (item.event_datetime) {
                    try {
                        var d = new Date(item.event_datetime);
                        if (!isNaN(d)) {
                            displayDate = d.toLocaleString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
                        }
                    } catch(e) {}
                }

                var safeTitle = item.event_title ? item.event_title.replace(/"/g, '&quot;') : '';
                var safeVenue = item.venue_name ? item.venue_name.replace(/"/g, '&quot;') : '';
                var safePoster = item.poster_image_path ? item.poster_image_path : 'images/events/1.jpg';

                var mediaHtml = `<img src="${safePoster}" alt="${safeTitle}" style="width: 100%; height: 100%; object-fit: cover;" onerror="this.src='https://placehold.co/250x250/111/EEE?text=Image+Missing'">`;

                var encodedPayload = encodeURIComponent(JSON.stringify(item));

                var html = `
                    <div class="ev-card live-event-card reveal" data-payload="${encodedPayload}">
                        <div class="ev-card__poster">${mediaHtml}</div>
                        <div class="ev-card__info">
                            <h4 style="margin: 0 0 8px 0; font-family: var(--f-display), serif; font-size: 1.25rem; font-weight: 600; color: #fff; line-height: 1.3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${safeTitle}">${safeTitle}</h4>
                            ${displayDate ? `<div class="ev-detail"><i class="far fa-clock ev-detail__ico"></i><span class="ev-detail__text">${displayDate}</span></div>` : ''}
                            ${item.venue_name ? `<div class="ev-detail"><i class="fas fa-map-marker-alt ev-detail__ico"></i><span class="ev-detail__text">${safeVenue}</span></div>` : ''}
                            ${(item.ticket_sales_link || item.ticket_link) ? `
                            <div class="ev-card__ticket-cta">
                                <a href="${item.ticket_sales_link || item.ticket_link}" target="_blank" rel="noopener noreferrer"
                                   class="ev-card__ticket-btn"
                                   onclick="event.stopPropagation();"
                                   aria-label="Get tickets for ${safeTitle}">
                                    <i class="fa-solid fa-ticket" style="margin-right:6px;"></i>Get Tickets
                                    <i class="fa-solid fa-arrow-right" style="margin-left:4px;font-size:10px;"></i>
                                </a>
                            </div>` : ''}
                        </div>
                    </div>
                `;
                $grid.append(html);
            });

            // Re-trigger IntersectionObserver for newly added elements
            if ('IntersectionObserver' in window && typeof revealObserver !== 'undefined') {
                $grid.find('.live-event-card.reveal').each(function() {
                    revealObserver.observe(this);
                });
            }
        }

        populateGrid($upcomingGrid, upcomingEvents, "No upcoming events at the moment.");
        populateGrid($pastGrid, pastEvents, "No past events at the moment.");

        // Re-trigger reveal observer for newly added event cards
        if (typeof revealObserver !== 'undefined') {
            $('.live-event-card.reveal').each(function() {
                revealObserver.observe(this);
            });
        }
    }
    renderEvents();

    // Safe HTML-entity decoder — uses a textarea so no scripts execute.
    function decodeHtmlEntities(str) {
        if (!str) return '';
        var ta = document.createElement('textarea');
        ta.innerHTML = str;
        return ta.value;
    }

    // Event Modal Click Handler (delegated since grid dynamically generated)
    $(document).on('click', '.live-event-card', function() {
        var payloadStr = $(this).attr('data-payload');
        if(!payloadStr) return;
        var item = JSON.parse(decodeURIComponent(payloadStr));

        // Populate Modal Fields
        $('#modalEventTitle').text(decodeHtmlEntities(item.event_title) || 'Event Details');
        $('#modalEventDesc').text(decodeHtmlEntities(item.event_description) || '');
        
        var displayDateStr = item.event_datetime || 'TBA';
        try {
            var d = new Date(item.event_datetime);
            if (!isNaN(d)) {
                displayDateStr = d.toLocaleString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
            }
        } catch(e) {}
        $('#modalEventDate').text(displayDateStr);

        $('#modalEventVenue').text(decodeHtmlEntities(item.venue_name) || 'TBA');
        
        // Maps linking logic
        if(item.venue_map_link) {
            $('#modalEventVenueLink').attr('href', item.venue_map_link);
            $('#modalEventVenueLink').css('pointer-events', 'auto');
        } else {
            $('#modalEventVenueLink').removeAttr('href'); 
            $('#modalEventVenueLink').css('pointer-events', 'none');
        }
        
        // Ticket linking logic — supports both manually created events (ticket_sales_link)
        // and booking-promoted shows (ticket_link)
        var ticketUrl = item.ticket_sales_link || item.ticket_link;
        if (ticketUrl) {
            $('#modalEventTicketBtn').attr('href', ticketUrl).show();
        } else {
            $('#modalEventTicketBtn').hide();
        }

        $('#modalEventPoster').attr('src', item.poster_image_path || 'images/events/1.jpg');

        $('#eventDetailsModal').modal('show');
    });

    // Lightbox Logic
    var lightboxData = [];
    var currentLightboxIndex = 0;

    $(document).on('click', '.insta-item img', function() {
        var $grid = $(this).closest('.insta-grid');
        var $images = $grid.find('.insta-item img');
        
        lightboxData = [];
        $images.each(function(index) {
            var src = $(this).attr('src');
            var desc = $(this).attr('data-desc') || $(this).attr('alt') || '';
            var date = $(this).attr('data-date') || '';
            var venue = $(this).attr('data-venue') || '';
            
            lightboxData.push({
                src: src,
                desc: desc,
                date: date,
                venue: venue
            });
        });
        
        currentLightboxIndex = $images.index(this);
        updateLightbox();
        $('#lightboxOverlay').fadeIn(200);
        $('body').css('overflow', 'hidden'); // Prevent background scroll
    });

    function updateLightbox() {
        if (lightboxData.length === 0) return;
        var item = lightboxData[currentLightboxIndex];
        $('#lightboxImage').attr('src', item.src);
        
        var captionHtml = '';
        if (item.desc) captionHtml += '<strong>' + item.desc + '</strong>';
        if (item.date) captionHtml += '<span style="display:inline-block; margin-right:15px;"><i class="glyphicon glyphicon-time" style="margin-right:5px; font-size:0.9em;"></i>' + item.date + '</span>';
        if (item.venue) captionHtml += '<span style="display:inline-block;"><i class="glyphicon glyphicon-map-marker" style="margin-right:5px; font-size:0.9em;"></i>' + item.venue + '</span>';
        
        $('#lightboxCaption').html(captionHtml);
    }

    $('.lightbox-close').on('click', function() {
        $('#lightboxOverlay').fadeOut(200);
        $('body').css('overflow', 'auto');
    });

    $('.lightbox-next').on('click', function(e) {
        e.stopPropagation();
        currentLightboxIndex = (currentLightboxIndex + 1) % lightboxData.length;
        updateLightbox();
    });

    $('.lightbox-prev').on('click', function(e) {
        e.stopPropagation();
        currentLightboxIndex = (currentLightboxIndex - 1 + lightboxData.length) % lightboxData.length;
        updateLightbox();
    });

    $('#lightboxOverlay').on('click', function(e) {
        if ($(e.target).is('#lightboxOverlay')) {
            $(this).fadeOut(200);
            $('body').css('overflow', 'auto');
        }
    });

    // 9. Dynamic Milestones Rendering (expanding-panel selector) — same /api/public/highlights
    // contract and image/YouTube/Vimeo trichotomy the old accordion used, new presentation only.
    var MS_ICON_MAP = { mic: 'fa-microphone', tv: 'fa-tv', headphones: 'fa-headphones', plane: 'fa-plane', pen: 'fa-pen-nib', trophy: 'fa-trophy', camera: 'fa-camera', star: 'fa-star' };

    function msYouTubeVideoId(url) {
        var videoId = '';
        if (url.includes('watch?v=')) videoId = url.split('watch?v=')[1].substring(0, 11);
        else if (url.includes('youtu.be/')) videoId = url.split('youtu.be/')[1].substring(0, 11);
        else if (url.includes('embed/')) { var parts = url.split('embed/'); if (parts.length > 1) videoId = parts[1].substring(0, 11); }
        return (videoId && videoId.length === 11) ? videoId : null;
    }
    function msYouTubeEmbedUrl(videoId) {
        // origin= is required by some videos' embed restrictions (commonly triggers YouTube's
        // "Error 153" without it). Even with it, a video's owner can still disable embedding
        // entirely (common for official/network channel uploads) — nothing client-side can force
        // that to work, hence the always-visible "Watch on YouTube" fallback link this pairs with.
        return 'https://www.youtube.com/embed/' + videoId + '?autoplay=1&origin=' + encodeURIComponent(window.location.origin);
    }

    function msEmbedVideo($opt) {
        var embedUrl = $opt.attr('data-embed-url');
        var watchUrl = $opt.attr('data-watch-url');
        if (!embedUrl || $opt.find('.ms-option__embed').length) return;
        // Some videos (commonly official/network channel uploads) have embedding disabled by their
        // owner on YouTube/Vimeo's side — nothing this page can do makes those play inline. The
        // "Watch on YouTube/Vimeo" link stays visible regardless, so it's never a dead end.
        var watchLinkHtml = watchUrl
            ? '<a class="ms-option__watch-link" href="' + watchUrl + '" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation();"><i class="fa-solid fa-arrow-up-right-from-square"></i> Watch on ' + (watchUrl.includes('vimeo') ? 'Vimeo' : 'YouTube') + '</a>'
            : '';
        $opt.append('<div class="ms-option__embed"><iframe src="' + embedUrl + '" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>' + watchLinkHtml + '</div>');
    }

    function msWireInteractions() {
        var $row = $('#milestonesRow');
        $row.off('click.milestones keydown.milestones');

        // One click both expands a panel AND plays its video, if it has one — matches the old
        // accordion's single-click-to-watch behavior. No separate play-button click required.
        $row.on('click.milestones', '.ms-option', function() {
            var $opt = $(this);
            if ($opt.hasClass('is-active')) return;
            $row.find('.ms-option').removeClass('is-active').attr('aria-expanded', 'false').find('.ms-option__embed').remove();
            $opt.addClass('is-active').attr('aria-expanded', 'true');
            msEmbedVideo($opt);
        });

        $row.on('keydown.milestones', '.ms-option', function(e) {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $(this).trigger('click'); }
        });
    }

    async function renderCareer() {
        var parsed = [];
        try {
            const response = await fetch('/api/public/highlights');
            const data = await response.json();
            if (Array.isArray(data)) {
                parsed = data;
            }
        } catch (err) {
            console.error("Failed to load career highlights from server:", err);
        }

        var $row = $('#milestonesRow');
        if (!$row.length) return;

        if (!parsed.length) {
            // No highlights on file (fresh install, or fetch failed) — hide the whole section
            // rather than showing an empty heading over a blank panel row.
            $row.closest('.tm-section').hide();
            return;
        }

        $row.empty();
        parsed.forEach(function(item, index) {
            var iconClass = MS_ICON_MAP[item.icon] || MS_ICON_MAP.star;
            var media = item.image_path || '';
            var mediaType = 'none';
            var embedUrl = null;
            var watchUrl = null;

            if (media) {
                if (media.startsWith('data:image') || media.match(/\.(jpeg|jpg|gif|png|webp)$/i) != null) {
                    mediaType = 'image';
                } else if (media.includes('youtube.com') || media.includes('youtu.be') || media.includes('embed/')) {
                    var ytId = msYouTubeVideoId(media);
                    if (ytId) {
                        mediaType = 'video';
                        embedUrl = msYouTubeEmbedUrl(ytId);
                        watchUrl = 'https://www.youtube.com/watch?v=' + ytId;
                    }
                } else if (media.includes('vimeo')) {
                    mediaType = 'video';
                    embedUrl = media; // trusted as-is, matches the old accordion's own Vimeo handling
                    watchUrl = media;
                }
            }

            var descText = '';
            if (item.description) {
                var firstPara = item.description.split('\n').filter(function(p) { return p.trim().length > 0; })[0];
                descText = firstPara || '';
            }

            var metaHtml = '';
            if (item.badge) metaHtml += '<span class="ms-option__pill">' + item.badge + '</span>';
            if (item.location) metaHtml += '<span class="ms-option__loc"><i class="fa-solid fa-location-dot"></i> ' + item.location + '</span>';

            var $opt = $('<div>')
                .addClass('ms-option' + (index === 0 ? ' is-active' : ''))
                .attr({
                    role: 'button', tabindex: '0',
                    'aria-expanded': index === 0 ? 'true' : 'false',
                    'aria-label': (item.year ? item.year + ' — ' : '') + item.title,
                    'data-embed-url': embedUrl || '',
                    'data-watch-url': watchUrl || ''
                });
            if (mediaType === 'image') $opt.css('background-image', 'url("' + media + '")');

            $opt.append('<div class="ms-option__wash"></div>');
            $opt.append('<div class="ms-option__badge"><i class="fa-solid ' + iconClass + '"></i></div>');
            if (mediaType === 'video' && embedUrl) $opt.append('<div class="ms-option__video-badge" title="Includes video"><i class="fa-solid fa-play"></i></div>');
            $opt.append(
                '<div class="ms-option__content">' +
                    (item.year ? '<span class="ms-option__index">' + item.year + '</span>' : '') +
                    '<h3 class="ms-option__title">' + item.title + '</h3>' +
                    (descText ? '<p class="ms-option__desc">' + descText + '</p>' : '') +
                    (metaHtml ? '<div class="ms-option__meta">' + metaHtml + '</div>' : '') +
                '</div>'
            );
            $row.append($opt);
            // The first panel starts active without going through the click handler — embed its
            // video immediately too, so a video-type highlight autoplays on page load like any
            // other active panel, not just after the visitor clicks something else first.
            if (index === 0 && mediaType === 'video' && embedUrl) msEmbedVideo($opt);
        });

        msWireInteractions();
    }

    renderCareer();

    // 9b. Dynamic Footprint Rendering (countries performed in — flag grid)
    async function renderFootprint() {
        var countries = [];
        try {
            const response = await fetch('/api/public/footprint');
            const data = await response.json();
            if (Array.isArray(data)) countries = data;
        } catch (err) {
            console.error("Failed to load footprint countries from server:", err);
        }

        var $grid = $('#footprintGrid');
        if (!$grid.length) return;

        if (!countries.length) {
            $grid.closest('.tm-section').hide();
            return;
        }

        $grid.empty();
        countries.forEach(function (c) {
            var $card = $('<div>').addClass('fp-card tm-reveal').attr('role', 'listitem');
            $card.append($('<img>').addClass('fp-flag').attr({ src: c.flag_image_path, alt: 'Flag of ' + c.country_name, loading: 'lazy' }));
            $card.append($('<p>').addClass('fp-name').text(c.country_name));
            $grid.append($card);
        });

        // Newly-injected .tm-reveal cards need to be registered with the page's IntersectionObserver
        // reveal system (it only auto-wires elements present at initial page load).
        $grid.find('.tm-reveal').addClass('reveal');
        if ('IntersectionObserver' in window && typeof revealObserver !== 'undefined') {
            $grid.find('.reveal').each(function () { revealObserver.observe(this); });
        } else {
            $grid.find('.reveal').addClass('active');
        }
    }
    renderFootprint();

    // 9c. Testimonials — vanilla-JS port of the "circular"/depth-stack carousel (no React/Babel
    // dependency added to this codebase), plus the public submission form.
    var ctState = { items: [], activeIndex: 0, autoplayTimer: null };

    // Referenced from an inline onerror="" attribute, so it must hang off window rather than
    // stay a closure-local function — inline handlers always run in the global scope.
    window.ctThumbFallback = function (imgEl) {
        var slot = imgEl.closest('.ct-image-slot');
        if (!slot) return;
        slot.classList.add('ct-monogram');
        slot.textContent = (imgEl.alt || '?').trim().charAt(0).toUpperCase() || '?';
    };

    function ctSlotHtml(item, pos) {
        var safeName = $('<span>').text(item.name || '').html();
        var isMonogram = !item.image_path;
        var inner = isMonogram
            ? (item.name || '?').trim().charAt(0).toUpperCase()
            : '<img src="' + item.image_path + '" alt="' + safeName + '" onerror="window.ctThumbFallback(this)">';
        return '<div class="ct-image-slot' + (isMonogram ? ' ct-monogram' : '') + '" data-pos="' + pos + '">' + inner + '</div>';
    }

    function ctRenderSlots() {
        var n = ctState.items.length;
        var $container = $('#ctImageContainer');
        $container.empty();
        for (var i = 0; i < n; i++) {
            var pos = 'hidden';
            if (i === ctState.activeIndex) pos = 'active';
            else if (n > 1 && i === (ctState.activeIndex - 1 + n) % n) pos = 'prev';
            else if (n > 1 && i === (ctState.activeIndex + 1) % n) pos = 'next';
            $container.append(ctSlotHtml(ctState.items[i], pos));
        }
    }

    function ctRenderContent() {
        var item = ctState.items[ctState.activeIndex];
        if (!item) return;
        $('#ctName').text(item.name || '');
        $('#ctDesignation').text(item.designation || '');
        $('#ctQuote').text(item.quote || '');
        // Restart the fade-in animation on every change.
        var el = document.getElementById('ctFadeIn');
        if (el) {
            el.classList.remove('ct-fade-in');
            void el.offsetWidth; // force reflow so the animation replays
            el.classList.add('ct-fade-in');
        }
    }

    function ctGoTo(index) {
        var n = ctState.items.length;
        if (!n) return;
        ctState.activeIndex = ((index % n) + n) % n;
        ctRenderSlots();
        ctRenderContent();
    }
    function ctResetAutoplay() {
        if (ctState.autoplayTimer) clearInterval(ctState.autoplayTimer);
        if (ctState.items.length > 1) {
            ctState.autoplayTimer = setInterval(function () { ctGoTo(ctState.activeIndex + 1); }, 6000);
        }
    }
    function ctNext() { ctGoTo(ctState.activeIndex + 1); ctResetAutoplay(); }
    function ctPrev() { ctGoTo(ctState.activeIndex - 1); ctResetAutoplay(); }

    async function renderTestimonials() {
        var items = [];
        try {
            const response = await fetch('/api/public/testimonials');
            const data = await response.json();
            if (Array.isArray(data)) items = data;
        } catch (err) {
            console.error("Failed to load testimonials from server:", err);
        }

        ctState.items = items;
        ctState.activeIndex = 0;
        var $wrap = $('#testimonialsCarouselWrap');

        // Below 3 items the "3-slot depth stack" degrades: 0 -> the carousel hides (the
        // submission form below stays visible either way); 1 -> single centered card, no
        // arrows/autoplay; 2+ -> normal stack + arrows + autoplay.
        if (!items.length) {
            $wrap.hide();
            return;
        }
        $wrap.show();
        $('#ctArrowButtons').toggle(items.length > 1);
        ctRenderSlots();
        ctRenderContent();
        ctResetAutoplay();
    }
    renderTestimonials();

    $(document).on('click', '#ctNextBtn', ctNext);
    $(document).on('click', '#ctPrevBtn', ctPrev);
    $(document).on('keydown', function (e) {
        if (!$('#testimonialsCarouselWrap').is(':visible')) return;
        if (e.key === 'ArrowLeft') ctPrev();
        else if (e.key === 'ArrowRight') ctNext();
    });

    // ── Testimonial photo dropzone (native file-input-drop, so no manual DataTransfer wiring
    // is needed — the invisible input covers the whole zone and browsers drop files onto it
    // directly; the drag listeners below are purely for the visual highlight). ──
    function tsResetPhotoZone() {
        $('#tsPhotoZone').removeClass('ts-file-zone--dragover');
        $('#tsPhotoPreview').hide();
        $('#tsPhotoPrompt').show();
        $('#tsPhotoPreviewImg').attr('src', '');
        $('#tsPhotoName').text('');
    }

    $(document).on('change', '#tsPhoto', function () {
        var file = this.files[0];
        if (!file) { tsResetPhotoZone(); return; }
        if (file.size > 8 * 1024 * 1024) {
            window.notificationService.showWarning('Photo Too Large', 'Please choose an image under 8 MB.');
            this.value = '';
            tsResetPhotoZone();
            return;
        }
        var reader = new FileReader();
        reader.onload = function (e) {
            $('#tsPhotoPreviewImg').attr('src', e.target.result);
            $('#tsPhotoName').text(file.name);
            $('#tsPhotoPrompt').hide();
            $('#tsPhotoPreview').show();
        };
        reader.readAsDataURL(file);
    });

    $(document).on('click', '#tsPhotoRemove', function (e) {
        e.preventDefault();
        e.stopPropagation();
        $('#tsPhoto').val('');
        tsResetPhotoZone();
    });

    $(document).on('dragenter dragover', '#tsPhotoZone', function (e) {
        e.preventDefault();
        $(this).addClass('ts-file-zone--dragover');
    });
    $(document).on('dragleave drop', '#tsPhotoZone', function () {
        $(this).removeClass('ts-file-zone--dragover');
    });

    // ── Testimonial submission form ──
    $(document).on('submit', '#testimonialSubmitForm', async function (e) {
        e.preventDefault();
        var $form = $(this);
        $form.find('.tm-field-error').text('');

        var name = $('#tsName').val().trim();
        var designation = $('#tsDesignation').val().trim();
        var quote = $('#tsQuote').val().trim();
        var consent = $('#tsConsent').is(':checked');
        var file = $('#tsPhoto')[0].files[0];

        var firstInvalid = null;
        function invalid($field, errId, message) {
            $('#' + errId).text(message);
            if (!firstInvalid) firstInvalid = $field;
        }
        if (!name) invalid($('#tsName'), 'errTsName', 'Please enter your name.');
        if (!quote) invalid($('#tsQuote'), 'errTsQuote', 'Please share a few words about your experience.');
        if (!consent) invalid($('#tsConsent'), 'errTsConsent', "Please confirm you're okay with this being shown publicly.");
        if (firstInvalid) { firstInvalid.trigger('focus'); return; }

        var $btn = $('#testimonialSubmitBtn');
        var originalBtnHtml = $btn.html();
        $btn.prop('disabled', true).html('<i class="fa fa-spinner fa-spin"></i>');

        try {
            var formData = new FormData();
            formData.append('name', name);
            formData.append('designation', designation);
            formData.append('quote', quote);
            if (file) formData.append('file', file);
            const res = await fetch('/api/public/testimonials', { method: 'POST', body: formData });
            const result = await res.json();
            if (!res.ok) throw new Error(result.message || 'Submission failed');
            $form[0].reset();
            $('#testimonialModal').modal('hide');
            window.notificationService.showSuccess(result.message || 'Thank you! Your testimonial has been submitted for review.');
        } catch (err) {
            console.error("Testimonial submission error:", err);
            window.notificationService.showError('Could not submit your testimonial. Please try again later.');
        } finally {
            $btn.prop('disabled', false).html(originalBtnHtml);
        }
    });

    // Reset the form (and any leftover field errors) each time the modal closes,
    // so reopening it after a cancelled attempt starts clean.
    $('#testimonialModal').on('hidden.bs.modal', function () {
        var $form = $('#testimonialSubmitForm');
        $form[0].reset();
        $form.find('.tm-field-error').text('');
        tsResetPhotoZone();
    });


    // 11. Dynamic Social Icons & Embeds Rendering
    async function renderSocial() {
        try {
            // Fetch both links and embeds concurrently
            const [linksRes, embedsRes] = await Promise.all([
                fetch('/api/public/social_links'),
                fetch('/api/public/social_embeds')
            ]);
            
            const parsedLinks = await linksRes.json();
            const embedList = await embedsRes.json();

            // 11a. Render Social Links (Social section + Footer)
            var $socialContainer = $('#dynamicSocialIcons');
            var $footerSocialIcons = $('#footerSocialIcons');
            [$socialContainer, $footerSocialIcons].forEach(function($container) {
                if ($container.length > 0) {
                    $container.empty();
                    parsedLinks.forEach(function(item) {
                        var html = item.icon_class
                            ? `<a href="${item.platform_url}" target="_blank" class="social-icon-wrapper" title="${item.platform_name}"><i class="${item.icon_class}"></i></a>`
                            : `<a href="${item.platform_url}" target="_blank" class="social-icon-wrapper" title="${item.platform_name}"><i class="fa-solid fa-link"></i></a>`;
                        $container.append(html);
                    });
                }
            });

            // 11b. Render Media Embeds (Video Grid)
            var $embedsRow = $('#dynamicEmbedsRow');
            if ($embedsRow.length > 0) {
                $embedsRow.empty(); // replace any hardcoded placeholders
                embedList.forEach(function(item) {
                    var col = $('<div class="embed-grid-item"></div>');
                    var embedHtml = '';
                    
                    let meta = null;
                    try { meta = item.metadata ? JSON.parse(item.metadata) : null; } catch(e) {}
                    
                    if (meta) {
                        var bgColors = {
                            "YouTube": "#D4AF37", "Vimeo": "#1ab7ea", "Twitch": "#9146FF", 
                            "Facebook": "#1877F2", "Instagram": "#E1306C", "TikTok": "#00f2fe",
                            "Dailymotion": "#0066dc", "X (Twitter)": "#1DA1F2", "LinkedIn": "#0077b5"
                        };
                        var icons = {
                            "YouTube": "fa-brands fa-youtube", "Vimeo": "fa-brands fa-vimeo", "Twitch": "fa-brands fa-twitch", 
                            "Facebook": "fa-brands fa-facebook", "Instagram": "fa-brands fa-instagram", "TikTok": "fa-brands fa-tiktok",
                            "Dailymotion": "fa-solid fa-play", "X (Twitter)": "fa-brands fa-x-twitter", "LinkedIn": "fa-brands fa-linkedin"
                        };
                        var pColor = bgColors[item.platform_name] || "#D4AF37";
                        var pIcon = icons[item.platform_name] || "fa-solid fa-play";
                        
                        var activeHtml = item.embed_code;
                        if (item.platform_name === 'YouTube') {
                            var ytUrl = item.embed_code;
                            if (ytUrl.includes('<iframe')) {
                                var srcMatch = ytUrl.match(/src="([^"]+)"/);
                                ytUrl = srcMatch ? srcMatch[1] : '';
                            } else ytUrl = ytUrl.replace('watch?v=', 'embed/').split('&')[0];
                            var autoplayUrl = ytUrl.includes('?') ? ytUrl + '&autoplay=1' : ytUrl + '?autoplay=1';
                            activeHtml = `<iframe width="100%" height="480" src="${autoplayUrl}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>`;
                        } else if (item.platform_name === 'Vimeo') {
                            var vMatch = item.embed_code.match(/vimeo\.com\/(\d+)/);
                            if (vMatch) activeHtml = `<iframe width="100%" height="480" src="https://player.vimeo.com/video/${vMatch[1]}?autoplay=1" frameborder="0" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe>`;
                        } else if (item.platform_name === 'Dailymotion') {
                            var dMatch = item.embed_code.match(/video\/([a-zA-Z0-9]+)/);
                            if (dMatch) activeHtml = `<iframe width="100%" height="480" src="https://www.dailymotion.com/embed/video/${dMatch[1]}?autoplay=1" frameborder="0" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe>`;
                        }
                        
                        var tagsArr = meta.tags || [];
                        var tagsHtml = tagsArr.slice(0, 5).map(t => `<span class="badge" style="background:${pColor}; color:#fff; margin-right:5px; margin-bottom:5px;">#${t}</span>`).join('');
                        var statsHtml = `<small style="color:var(--text-muted); font-size:.75rem;">${parseInt(meta.viewCount || 0).toLocaleString()} views &nbsp;&bull;&nbsp; ${parseInt(meta.likeCount || 0).toLocaleString()} likes</small><br>`;
                        
                        var GIF_BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
                        var safeThumb = (meta.thumbnail && meta.thumbnail !== GIF_BLANK) ? meta.thumbnail : (function() {
                            var ec = item.embed_code || '';
                            var ytRe = ec.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([\w-]{11})/);
                            return (ytRe && ytRe[1]) ? 'https://img.youtube.com/vi/' + ytRe[1] + '/hqdefault.jpg' : GIF_BLANK;
                        }());
                        embedHtml = `
                        <div class="youtube-custom-card reveal"
                             style="background:var(--bg-surface); border-radius:var(--r-md); overflow:hidden; box-shadow:var(--sh-sm); cursor:pointer; position:relative; border: 1px solid var(--border-low);"
                             onclick="const active = '${activeHtml.replace(/'/g, "\\'").replace(/"/g, "&quot;")}' ; $(this).parent().html(active);">
                            <div style="position:relative; background:#000; width: 100%; aspect-ratio: 16 / 9; overflow:hidden;">
                                <img src="${safeThumb}" onerror="this.onerror=null;this.src='data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';" alt="Video Thumbnail" style="width:100%; height:100%; display:block; object-fit: cover; opacity: 0.85;">
                                <div style="position:absolute; top:50%; left:50%; transform:translate(-50%, -50%); color:${pColor}; font-size:48px; text-shadow:0 0 10px rgba(0,0,0,0.5);"><i class="${pIcon}"></i></div>
                                <div style="position:absolute; top:12px; left:12px; background:rgba(0,0,0,0.7); color:#fff; font-size:10px; padding:4px 8px; border-radius:4px; letter-spacing:0.05em; text-transform:uppercase;">${item.platform_name}</div>
                            </div>
                            <div style="padding:18px; color:#fff; flex-grow: 1; display:flex; flex-direction:column; justify-content: space-between;">
                                <div>
                                    <h4 style="margin:0 0 8px; color:var(--text-primary); font-family:var(--f-display); font-size:1.15rem; line-height:1.4;">${meta.title || 'Untitled Video'}</h4>
                                    <p style="color:var(--text-secondary); font-size:12px; margin-bottom:12px;">
                                        <strong>${meta.channelName || 'Official'}</strong> &bull; ${meta.publishDate ? new Date(meta.publishDate).toLocaleDateString() : ''}
                                    </p>
                                    <p style="font-size:13px; color:var(--text-muted); display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; line-height:1.5;">${meta.description || 'Watch the latest from Thabiso Mhlongo.'}</p>
                                </div>
                                <div style="margin-top:14px; display:flex; flex-wrap:wrap; gap:6px;">${tagsHtml}</div>
                            </div>
                        </div>
                        `;
                    } else {
                        // Fallback: direct render for platforms that refused metadata fetch
                        embedHtml = item.embed_code;
                        if (!embedHtml.includes('<iframe') && !embedHtml.includes('<blockquote')) {
                            embedHtml = `<iframe width="100%" height="480" src="${item.embed_code}" frameborder="0" allowfullscreen style="border-radius:12px;"></iframe>`;
                        }
                    }
                    col.html(embedHtml);
                    $embedsRow.append(col);
                });

                // Re-trigger reveal observer for newly added social cards
                if (typeof revealObserver !== 'undefined') {
                    $embedsRow.find('.youtube-custom-card.reveal, .reveal').each(function() {
                        revealObserver.observe(this);
                    });
                }
            }
        } catch(err) {
            console.error("Failed to fetch Social API Data:", err);
        }
    }
    renderSocial();

});

// --- Scroll Position Persistence ---
document.addEventListener("DOMContentLoaded", function() { 
    // var scrollpos = sessionStorage.getItem('index_scrollpos');
    // if (scrollpos) window.scrollTo(0, scrollpos); // Disabled to prevent jumps and crashes during loops

    // ==========================================
    // INITIALIZE DYNAMIC CONTACT INFO
    // ==========================================
    async function renderContactInfo() {
        try {
            const response = await fetch('/api/public/contact_info');
            const data = await response.json();
            
            if (data && !data.error) {
                if (data.quote) $('#dynamicContactQuote p:first').html(data.quote);
                if (data.signature) $('#dynamicContactName').text(data.signature);
            }
        } catch (e) {
            console.error("Failed to load contact info:", e);
        }
    }
    renderContactInfo();

    async function renderPublicManager() {
        var $mgrTable = $('#managerTable');
        if (!$mgrTable.length) return;

        try {
            const response = await fetch('/api/public/manager');
            const data = await response.json();
            
            if (data && !data.error && data.name) {
                $('#dynamicManagerName').text(data.name || '');
                $('#dynamicManagerCell').text(data.cell_number || '');
                if (data.whatsapp_link) {
                    $('#dynamicManagerWhatsApp').html('<a href="' + data.whatsapp_link + '" target="_blank">' + (data.whatsapp_number || '') + '</a>');
                } else if (data.whatsapp_number) {
                    const cleanPhone = data.whatsapp_number.replace(/\D/g, '');
                    $('#dynamicManagerWhatsApp').html('<a href="https://wa.me/' + cleanPhone + '" target="_blank">' + data.whatsapp_number + '</a>');
                } else {
                    $('#dynamicManagerWhatsApp').empty();
                }
                if (data.email) {
                    $('#dynamicManagerEmail').text(data.email).attr('href', 'mailto:' + data.email);
                }
                $mgrTable.closest('.row').show();
            } else {
                $mgrTable.closest('.row').hide();
            }
        } catch(e) {
            console.error("Failed to load manager details:", e);
            $mgrTable.closest('.row').hide();
        }
    }
    renderPublicManager();

    // Initialize intl-tel-input for the contact form cell number
    var input = document.querySelector("#contactCell");
    if (input) {
        window.itiContact = window.intlTelInput(input, {
            utilsScript: "https://cdnjs.cloudflare.com/ajax/libs/intl-tel-input/17.0.19/js/utils.js",
            separateDialCode: true,
            initialCountry: "za"
        });
    }

    // ==========================================
    // INITIALIZE NEWSLETTER SUBSCRIPTION
    // ==========================================
    var $newsletterForm = $('#newsletterSubscribeForm');

    if ($newsletterForm.length) {
        // Clear a field's inline error as soon as the visitor edits it.
        $newsletterForm.on('input change', '.tm-nl-input, #newsletterPopia', function() {
            var $err = $(this).closest('.tm-form-group, .tm-newsletter-consent').find('.tm-field-error');
            $err.text('');
        });

        $newsletterForm.on('submit', async function(e) {
            e.preventDefault();

            $newsletterForm.find('.tm-field-error').text('');

            var firstName = $('#newsletterFirstName').val().trim();
            var email = $('#newsletterSubscribeEmail').val().trim();
            var birthdayDay = $('#newsletterBirthdayDay').val();
            var birthdayMonth = $('#newsletterBirthdayMonth').val();
            var popiaChecked = $('#newsletterPopia').is(':checked');
            var emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

            var firstInvalid = null;
            function invalid($field, errId, message) {
                $('#' + errId).text(message);
                if (!firstInvalid) firstInvalid = $field;
            }

            if (!firstName) invalid($('#newsletterFirstName'), 'errNewsletterFirstName', 'Please enter your first name.');
            if (!email || !emailRe.test(email)) invalid($('#newsletterSubscribeEmail'), 'errNewsletterEmail', 'Please enter a valid email address.');
            if ((birthdayDay && !birthdayMonth) || (!birthdayDay && birthdayMonth)) {
                invalid($('#newsletterBirthdayDay'), 'errNewsletterBirthday', 'Please select both a day and a month.');
            }
            if (!popiaChecked) invalid($('#newsletterPopia'), 'errNewsletterPopia', 'Please accept the Privacy Policy to subscribe.');

            if (firstInvalid) {
                firstInvalid.trigger('focus');
                return;
            }

            var $btn = $(this).find('button[type="submit"]');
            var originalBtnHtml = $btn.html();
            $btn.prop('disabled', true).html('<i class="fa fa-spinner fa-spin"></i>');

            try {
                const res = await fetch('/api/public/subscribe', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        email: email,
                        first_name: firstName,
                        birthday_day: birthdayDay || null,
                        birthday_month: birthdayMonth || null,
                        popia_consent: popiaChecked
                    })
                });
                const result = await res.json();

                if (res.status === 409 || (result.message && result.message.includes('already subscribed'))) {
                    window.notificationService.showInfo('You are already subscribed to our inner circle list.');
                } else if (!res.ok) {
                    throw new Error(result.message || 'Subscription failed');
                } else {
                    $newsletterForm[0].reset();
                    window.notificationService.showSuccess(result.message || 'Almost there! Check your email to confirm your subscription.');
                }

            } catch (err) {
                console.error("Newsletter Subscription Error:", err);
                window.notificationService.showError('Could not subscribe at this time. Please try again later.');
            } finally {
                // Restore button state
                if ($btn) $btn.prop('disabled', false).html(originalBtnHtml);
            }
        });
    }

    // ==========================================
    // MULTI-STEP BOOKING FORM WIZARD
    // ==========================================
    var $bookingForm = $('#dedicatedBookingForm');
    if ($bookingForm.length) {
        var currentStep = 0;

        // --- SERVICES CATALOGUE (Add-Item Table) ---
        var _bkServicesCatalogue = [];

        async function loadServices() {
            try {
                let res = await fetch('/api/public/services');
                let services = await res.json();
                if (!Array.isArray(services)) return;
                _bkServicesCatalogue = services;

                var $dd = $('#bkServiceDropdown');
                if (!$dd.length) return;
                $dd.empty().append('<option value="">&#8212; Quick add from catalogue &#8212;</option>');
                services.forEach(function(s) {
                    $dd.append('<option value="' + s.id + '">' + s.name + '</option>');
                });


            } catch (err) {
                console.error('Failed to load services:', err);
            }
        }

        function getBkDurationMins() {
            var f = $('#bkSlotFrom').val();
            var t = $('#bkSlotTo').val();
            if (!f || !t) return 60; // Default to 60 min if no slot selected yet
            var fp = f.split(':'), tp = t.split(':');
            var diff = (parseInt(tp[0]) * 60 + parseInt(tp[1])) - (parseInt(fp[0]) * 60 + parseInt(fp[1]));
            if (diff < 0) diff += 1440;
            return diff > 0 ? diff : 60;
        }

        function formatDuration(mins) {
            if (!mins || mins <= 0) return '0m';
            var h = Math.floor(mins / 60);
            var m = mins % 60;
            if (h > 0 && m > 0) return h + 'h ' + m + 'm';
            if (h > 0) return h + 'h';
            return m + 'm';
        }


        function getSelectedServicesDuration() {
            var totalMins = 0;
            $('#bkServicesTableBody tr').each(function() {
                var $row = $(this);
                var model = $row.data('model');
                var qty = parseInt($row.find('.bk-svc-qty').val()) || 0;
                if (model === 'per_minute') {
                    totalMins += qty;
                } else if (model === 'per_hour') {
                    totalMins += qty * 60;
                } else {
                    var perfMins = parseInt($row.data('perf-mins')) || 0;
                    if (perfMins > 0) {
                        totalMins += perfMins;
                    }
                }
            });
            return totalMins;
        }

        function bkSyncDurationSelect() {
            var totalMins = getSelectedServicesDuration();
            var $select = $('#bkReadoutDurSelect');
            if (totalMins > 0) {
                var exists = $select.find('option[value="' + totalMins + '"]').length > 0;
                if (!exists) {
                    var label = formatDuration(totalMins);
                    $select.append($('<option>').val(totalMins).text(label));
                }
            }
            
            $select.find('option').each(function() {
                var val = parseInt($(this).val()) || 0;
                if (val < totalMins) {
                    $(this).prop('disabled', true);
                } else {
                    $(this).prop('disabled', false);
                }
            });

            var currentVal = parseInt($select.val()) || 0;
            if (currentVal < totalMins && totalMins > 0) {
                $select.val(totalMins).trigger('change');
            }
        }

        function bkSyncServiceQuantities() {
            // Slot changes no longer override per-service quantities.
            // We only update the over-slot warning badge on each time-based row.
            var durMins = getBkDurationMins();
            $('#bkServicesTableBody tr').each(function() {
                var $row = $(this);
                var model = $row.data('model');
                var isFlat = model === 'flat' || model === 'flat_fee';
                if (isFlat) return;

                var isPerMinute = model === 'per_minute';
                var isPerHour   = model === 'per_hour';
                var qty         = parseInt($row.find('.bk-svc-qty').val()) || 0;

                var exceedsSlot = false;
                if (durMins > 0) {
                    if (isPerMinute) exceedsSlot = qty > durMins;
                    else if (isPerHour) exceedsSlot = (qty * 60) > durMins;
                }

                var $warn = $row.find('.bk-over-slot-warn');
                if (exceedsSlot) {
                    if (!$warn.length) {
                        $row.find('.bk-svc-qty').after('<div class="bk-over-slot-warn" style="font-size:9px; color:#FF9800; margin-top:2px;">&#9888; Exceeds slot</div>');
                    }
                } else {
                    $warn.remove();
                }
            });
        }

        function bkAddServiceRow(svcId, svcName, unitPrice, qty, model, minQty, unit, svcMeta) {
            model   = model   || 'flat_fee';
            minQty  = minQty  || 1;
            unit    = unit    || '';
            svcMeta = svcMeta || {};

            var isFlat      = model === 'flat' || model === 'flat_fee';
            var isPerMinute = model === 'per_minute';
            var isPerHour   = model === 'per_hour';

            // Use the service's own performance_length_minutes as the quantity default.
            // Fall back to min_quantity, then 60 min (per_minute) or 1 (per_hour/flat).
            if (!qty || qty <= 0) {
                var perfMinsDefault = parseInt(svcMeta.performance_length_minutes) || 0;
                if (isPerMinute) qty = perfMinsDefault || parseInt(minQty) || 60;
                else if (isPerHour) qty = Math.ceil((perfMinsDefault || 60) / 60);
                else qty = 1;
            }

            qty = Math.max(parseInt(qty) || 1, parseInt(minQty) || 1);

            var inputLabel = (isPerMinute || isPerHour) ? 'Billable Qty' : 'Qty';
            // For time-based services show an editable duration hint instead of a locked value
            var durHint = isPerMinute
                ? '<span class="bk-dur-hint" style="font-size:10px; color:#D4AF37; margin-top:2px;">' + formatDuration(qty) + '</span>'
                : (isPerHour ? '<span class="bk-dur-hint" style="font-size:10px; color:#D4AF37; margin-top:2px;">' + qty + 'h</span>' : '');

            // Flat-fee services lock at qty 1; time-based are freely editable
            var disabledAttr = isFlat ? ' disabled' : '';
            var displayQty = isFlat ? 1 : qty;

            // Service metadata hints
            var perfMins = parseInt(svcMeta.performance_length_minutes) || 0;
            var perfHint = perfMins > 0
                ? '<div style="font-size:10px;color:#888;margin-top:2px;">~' + perfMins + ' min performance</div>'
                : '';
            var travelBadge = svcMeta.travel_included
                ? '<span style="display:inline-block;background:rgba(212,175,55,0.15);color:#D4AF37;border:1px solid rgba(212,175,55,0.3);border-radius:10px;font-size:9px;font-weight:700;padding:1px 7px;margin-top:3px;letter-spacing:0.4px;">Travel Incl.</span>'
                : '';
            var leadDays = parseInt(svcMeta.booking_lead_time_days) || 0;
            var leadWarn = leadDays > 0
                ? '<div style="font-size:10px;color:#e6a817;margin-top:2px;">&#9888; Requires ' + leadDays + ' day' + (leadDays !== 1 ? 's' : '') + ' notice</div>'
                : '';
            var perDayHint = svcMeta.availability_rule === 'per_day'
                ? '<div style="font-size:10px;color:#888;margin-top:2px;">1 booking per day limit</div>'
                : '';

            var $row = $(
                '<tr data-svc-id="' + svcId + '" data-unit-price="' + unitPrice + '" data-model="' + model + '" data-min-qty="' + minQty + '" data-perf-mins="' + perfMins + '">'
                + '<td style="padding:10px 12px; border:none; color:#ddd;">'
                +   '<div style="display:flex; align-items:center;">'
                +     '<i class="fa-solid fa-grip-lines" style="color:#333; margin-right:10px; font-size:10px;"></i>'
                +     '<div>'
                +       '<div>' + svcName + '</div>'
                +       (unit ? '<div style="font-size:10px; color:#666; text-transform:uppercase; letter-spacing:0.5px;">' + unit + '</div>' : '')
                +       perfHint + travelBadge + leadWarn + perDayHint
                +     '</div>'
                +   '</div>'
                + '</td>'
                + '<td style="padding:8px; border:none; text-align:center;">'
                +   '<div style="display:flex; flex-direction:column; align-items:center;">'
                +     '<input type="number" class="bk-svc-qty form-control" value="' + displayQty + '" min="' + minQty + '" max="9999" step="1"' + disabledAttr + ' style="background:#1a1a1a; border:1px solid #333; color:#fff; width:70px; text-align:center; border-radius:4px; padding:4px 6px; font-size:13px; font-weight:600;">'
                +     '<small style="font-size:9px; color:#555; margin-top:2px; text-transform:uppercase; font-weight:700;">' + inputLabel + '</small>'
                +     durHint
                +   '</div>'
                + '</td>'
                + '<td style="padding:8px; border:none; text-align:center;">'
                +   '<button type="button" class="bk-svc-remove" style="background:none; border:none; color:#444; font-size:14px; cursor:pointer; padding:10px; min-width:44px; min-height:44px; display:inline-flex; align-items:center; justify-content:center; transition:color 0.2s;" aria-label="Remove Service"><i class="fa-solid fa-trash"></i></button>'
                + '</td>'
                + '</tr>'
            );
            $('#bkServicesTableBody').append($row);
            $('#bkServicesTableWrap').fadeIn(300);
            $('#err-bookServices').hide();
        }

        // Add Service button
        $(document).on('click', '#bkAddServiceBtn', function() {
            var $dd = $('#bkServiceDropdown');
            var svcId = $dd.val();
            if (!svcId) { $dd.focus(); return; }
            var svc = _bkServicesCatalogue.find(function(s) { return String(s.id) === String(svcId); });
            if (!svc) return;
            // Check not already added
            if ($('#bkServicesTableBody tr[data-svc-id="' + svcId + '"]').length) {
                // Just increment quantity/duration instead
                var $existRow = $('#bkServicesTableBody tr[data-svc-id="' + svcId + '"]');
                var $qtyInput = $existRow.find('.bk-svc-qty');
                if (!$qtyInput.prop('disabled')) {
                    var step = 1; // Used to be 15 for time-based, now 1 for all
                    var newQty = (parseInt($qtyInput.val()) || 0) + step;
                    $qtyInput.val(newQty).trigger('change');
                }
                $dd.val('');
                
                // Pulsate the row briefly to show it updated
                $existRow.css('background', 'rgba(212,175,55,0.05)');
                setTimeout(function(){ $existRow.css('background', 'transparent'); }, 500);
                $('#bkSvcPreview').fadeOut(200);
                return;
            }
            // Default qty: use service's own performance_length_minutes, else min_quantity, else 60/1
            var perfMins = parseInt(svc.performance_length_minutes) || 0;
            var startQty;
            if (svc.pricing_model === 'per_minute') {
                startQty = perfMins || parseInt(svc.min_quantity) || 60;
            } else if (svc.pricing_model === 'per_hour') {
                startQty = Math.ceil((perfMins || 60) / 60);
            } else {
                startQty = 1;
            }
            bkAddServiceRow(svc.id, svc.name, parseFloat(svc.default_price) || 0, startQty, svc.pricing_model, svc.min_quantity, svc.display_unit, svc);
            $dd.val('');
            $('#bkSvcPreview').fadeOut(200);
            bkSyncDurationSelect();
        });

        // Dropdown change for price preview (pricing hidden)
        $(document).on('change', '#bkServiceDropdown', function() {
            var $preview = $('#bkSvcPreview');
            if ($preview.length) {
                $preview.fadeOut(200);
            }
        });

        // Quantity change
        $(document).on('change input', '.bk-svc-qty', function() {
            var $row = $(this).closest('tr');
            var qty = parseInt($(this).val()) || 0;
            var minQty = parseInt($row.data('min-qty')) || 1;
            var model = $row.data('model');
            
            if (qty < minQty) { 
                qty = minQty; 
                $(this).val(minQty);
                // Visual feedback for min hit
                $(this).css('border-color', '#ef5350');
                setTimeout(() => { $(this).css('border-color', '#333'); }, 600);
            }
            
            // Update duration hint
            if (model === 'per_minute') {
                $row.find('.bk-dur-hint').text(formatDuration(qty));
            } else if (model === 'per_hour') {
                $row.find('.bk-dur-hint').text(qty + 'h');
            }

            // Show/hide over-slot warning badge
            bkSyncServiceQuantities();
            bkSyncDurationSelect();
        });

        $(document).on('click', '.bk-svc-remove', function() {
            $(this).closest('tr').remove();
            if ($('#bkServicesTableBody tr').length === 0) {
                $('#bkServicesTableWrap').hide();
            }
            bkSyncDurationSelect();
        });

        // Always load services on init
        loadServices();

        // --- BOOKING CONFIG CACHE ---
        let _bkConfig = {}; // keyed by dow (0-6) or 'default'
        async function getBkConfig(dow) {
            const key = (dow !== undefined) ? dow : 'default';
            if (_bkConfig[key]) return _bkConfig[key];
            try {
                const url = dow !== undefined
                    ? '/api/public/booking-config?dow=' + dow
                    : '/api/public/booking-config';
                const r = await fetch(url);
                _bkConfig[key] = await r.json();
            } catch (e) {
                _bkConfig[key] = { working_hours_start: '09:00', working_hours_end: '22:00', is_working_day: true, min_booking_gap_minutes: 30 };
            }
            return _bkConfig[key];
        }

        // --- DATE AVAILABILITY PRE-CHECK ---
        let dateAvailable = false; // gate flag
        let currentBusyRanges = []; // store busy ranges for the selected date

        function setDateStatus(type, html) {
            // type: 'loading' | 'ok' | 'error' | 'warn' | 'clear'
            // setDateStatus is the single authority for all date field feedback —
            // always clear competing err div and CSS classes before applying new state.
            let $hint = $('#hint-bookDate');
            if (!$hint.length) {
                $('#err-bookDate').after('<div id="hint-bookDate" style="font-size:12px; margin-top:6px; line-height:1.5;"></div>');
                $hint = $('#hint-bookDate');
            }
            const $input = $('#bookDate');
            $input.css('border-color', '').removeClass('bk-input--err bk-input--ok');
            $('#err-bookDate').hide();
            if (type === 'loading') {
                $input.css('border-color', '#555');
                $hint.html('<i class="fa-solid fa-spinner fa-spin" style="margin-right:5px; color:#888;"></i><span style="color:#aaa;">' + html + '</span>').show();
            } else if (type === 'ok') {
                $input.css('border-color', '#4CAF50');
                $hint.html('<i class="fa-solid fa-circle-check" style="margin-right:5px; color:#4CAF50;"></i><span style="color:#4CAF50;">' + html + '</span>').show();
            } else if (type === 'error') {
                $input.css('border-color', '#ef5350');
                $hint.html('<i class="fa-solid fa-circle-xmark" style="margin-right:5px; color:#ef5350;"></i><span style="color:#ef5350;">' + html + '</span>').show();
            } else if (type === 'warn') {
                $input.css('border-color', '#FF9800');
                $hint.html('<i class="fa-solid fa-triangle-exclamation" style="margin-right:5px; color:#FF9800;"></i><span style="color:#FF9800;">' + html + '</span>').show();
            } else {
                $hint.text('').hide();
                $input.css('border-color', '');
            }
        }

        $('#bookDate').on('change', async function() {
            const date = $(this).val();
            dateAvailable = false;
            currentBusyRanges = [];
            $('#bookNext1').prop('disabled', true);

            if (!date) { setDateStatus('clear'); renderTimeSlots(); return; }

            setDateStatus('loading', 'Checking availability…');

            try {
                const r = await fetch('/api/public/availability?date=' + encodeURIComponent(date));
                const data = await r.json();

                if (data.available) {
                    dateAvailable = true;
                    currentBusyRanges = data.busy_ranges || [];
                    $('#bookNext1').prop('disabled', false);
                    
                    let msg = data.message || 'This date is available!';
                    if (currentBusyRanges.length > 0) {
                        msg += ' (Note: Some specific times are blocked)';
                    }
                    setDateStatus('ok', msg);
                } else {
                    dateAvailable = false;
                    let msg = data.message || 'This date is not available.';
                    if (data.suggestion && data.suggestion_label) {
                        msg += ` <a href="#" id="bk-use-suggestion" data-date="${data.suggestion}" style="color:#D4AF37; font-weight:600; text-decoration:underline;">Try ${data.suggestion_label} instead →</a>`;
                    }
                    const statusType = data.reason === 'too_soon' ? 'warn' : 'error';
                    setDateStatus(statusType, msg);
                }
                renderTimeSlots();
            } catch(e) {
                // On network error, allow continuation
                dateAvailable = true;
                $('#bookNext1').prop('disabled', false);
                setDateStatus('clear');
                renderTimeSlots();
            }
        });

        // Handle "use suggestion" click
        $(document).on('click', '#bk-use-suggestion', function(e) {
            e.preventDefault();
            const suggested = $(this).data('date');
            $('#bookDate').val(suggested).trigger('change');
        });

        // --- PERFORMANCE SLOT TIME RANGE PICKER ---
        function bkUpdateSlot() {
            var f = $('#bkSlotFrom').val();
            var t = $('#bkSlotTo').val();
            
            // Sync hidden start time for backend
            $('#bookStartTime').val(f);

            if (f === 'All Day' || f === 'Custom') {
                $('#bookSlot').val('All Day / Custom Hours');
                $('#bkReadoutText').html('<span style="color:var(--text-primary); font-style:italic;">All Day / Custom Hours</span>');
                $('#bkSmartReadout').css('display', 'flex');
                return;
            }

            if (f && t) {
                var fp = f.split(':'), tp = t.split(':');
                var diff = (parseInt(tp[0]) * 60 + parseInt(tp[1])) - (parseInt(fp[0]) * 60 + parseInt(fp[1]));
                if (diff < 0) diff += 1440;
                $('#bookSlot').val(f + '–' + t);

                if (diff > 0) {
                    $('#bkReadoutText').text(f + ' to ' + t);
                    $('#bkSmartReadout').css('display', 'flex');
                } else {
                    $('#bkSmartReadout').hide();
                }
            } else {
                $('#bookSlot').val(f || '');
                $('#bkSmartReadout').hide();
            }
            
            // Re-sync any duration-driven services
            if (typeof bkSyncServiceQuantities === 'function') {
                bkSyncServiceQuantities();
            }
        }
        $('#bkSlotFrom, #bkSlotTo').on('change', bkUpdateSlot);
        
        $('#bkReadoutDurSelect').on('change', function() {
            renderTimeSlots();
            
            var f = $('#bkSlotFrom').val();
            if (!f) return;
            
            const durMins = parseInt($(this).val()) || 60;
            const parts = f.split(':');
            let totalMins = parseInt(parts[0]) * 60 + parseInt(parts[1]) + durMins;
            
            let h = Math.floor(totalMins / 60);
            let m = totalMins % 60;
            if (h >= 24) { h = 23; m = 59; }
            
            const toTime = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
            $('#bkSlotTo').val(toTime).trigger('change');
        });

        async function renderTimeSlots() {
            const $grid = $('#bkTimeSlotsGrid');
            if (!$grid.length) return;

            $grid.empty();

            // If no date selected yet, leave grid empty
            const selectedDate = $('#bookDate').val();
            if (!selectedDate) return;

            // If date is selected but unavailable, show message
            if (!dateAvailable) {
                $grid.append('<div style="color:var(--text-muted); font-size:var(--fs-sm);">This date is not available.</div>');
                return;
            }

            // Fetch per-day working hours using the selected date's day-of-week
            const dow = new Date(selectedDate + 'T00:00:00').getDay(); // 0=Sun … 6=Sat
            const cfg = await getBkConfig(dow);

            if (cfg.is_working_day === false) {
                $grid.append('<div style="color:var(--text-muted); font-size:var(--fs-sm);">Not a working day — contact us for special arrangements.</div>');
                return;
            }

            const [startH, startM] = cfg.working_hours_start.split(':').map(Number);
            const [endH, endM]     = cfg.working_hours_end.split(':').map(Number);
            const endTotalMins     = endH === 0 && endM === 0 ? 1440 : (endH * 60 + (endM || 0));
            const slots = [];
            const loopEndH         = endH === 0 && endM === 0 ? 24 : endH;

            for (let h = startH; h < loopEndH; h++) {
                if (h === startH && startM >= 30) {
                    slots.push(`${String(h).padStart(2, '0')}:30`);
                } else {
                    slots.push(`${String(h).padStart(2, '0')}:00`);
                    slots.push(`${String(h).padStart(2, '0')}:30`);
                }
            }

            // Selected duration in minutes (from duration selector)
            const durMins = parseInt($('#bkReadoutDurSelect').val()) || 60;

            if (durMins >= 1440) {
                var $allDaySlot = $('<div class="bk-time-slot" data-time="All Day" style="width:100%; text-align:center; padding:12px; background:rgba(212,175,55,0.1); border-color:var(--y-base); color:var(--y-base); margin-top:8px;">' +
                    '<i class="fa-solid fa-sun" style="margin-right:8px;"></i> Confirm Full Day / Custom Hours' +
                '</div>');
                
                $allDaySlot.on('click', function() {
                    $('.bk-time-slot').removeClass('selected');
                    $(this).addClass('selected');
                    $('#bkSlotFrom').val('All Day').trigger('change');
                    $('#bkSlotTo').val('All Day').trigger('change');
                    
                    $('#err-bookSlot').hide();
                    $('#bkTimeSlotsGrid').removeClass('bk-input--err').removeAttr('aria-invalid').removeAttr('aria-describedby');
                });
                
                $grid.append($allDaySlot);
                return;
            }

            slots.forEach(time => {
                const $slot = $('<div class="bk-time-slot"></div>').text(time).attr('data-time', time);

                // Calculate the slot start and end times
                const [slotH, slotM] = time.split(':').map(Number);
                const slotStartMins = slotH * 60 + slotM;
                const slotEndMins = slotStartMins + durMins;
                const slotEndStr = `${String(Math.floor(slotEndMins / 60) % 24).padStart(2, '0')}:${String(slotEndMins % 60).padStart(2, '0')}`;

                // Check if already busy (existing booking / hold)
                let isBusy = false;
                if (currentBusyRanges && currentBusyRanges.length > 0) {
                    currentBusyRanges.forEach(r => {
                        // Check if the slot range overlaps with the busy range [r.start, r.end]
                        if ((time < r.end) && (r.start < slotEndStr)) {
                            isBusy = true;
                        }
                    });
                }

                // Also mark busy if slot + duration would exceed working hours end
                if (!isBusy) {
                    if (slotEndMins > endTotalMins) {
                        isBusy = true;
                        $slot.attr('title', `Requires ${durMins} min — exceeds working hours`);
                    }
                }

                if (isBusy) {
                    $slot.addClass('busy').attr({
                        'aria-disabled': 'true',
                        'aria-label': time + ' - Time Unavailable'
                    });
                } else {
                    $slot.on('click', function() {
                        $('.bk-time-slot').removeClass('selected');
                        $(this).addClass('selected');

                        const parts = time.split(':');
                        let totalMins = parseInt(parts[0]) * 60 + parseInt(parts[1]) + durMins;

                        let h = Math.floor(totalMins / 60);
                        let m = totalMins % 60;
                        if (h >= 24) { h = 23; m = 59; }

                        const toTime = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

                        $('#bkSlotFrom').val(time).trigger('change');
                        $('#bkSlotTo').val(toTime).trigger('change');
                    });
                }

                $grid.append($slot);
            });
        }

        // Patch Next button on step 1 to also gate on date availability
        const _origNext1 = $('#bookNext1').off('click').click;
        $('#bookNext1').on('click', function() {
            if (!dateAvailable) {
                const $hint = $('#hint-bookDate');
                if ($hint.length && !$hint.is(':visible')) setDateStatus('warn', 'Please select an available date before continuing.');
                return;
            }
            
            if (validateStep(1)) updateProgress(2);
        });

        // --- VENUE AUTOCOMPLETE (server-side proxy, no client-side Maps JS dependency) ---
        var _venueDebounce = null;
        var _venueInited = false;

        function initAutocomplete() {
            if (_venueInited) return;
            _venueInited = true;

            var $input = $('#bookLocation');
            var $dd    = $('#venueDropdown');

            $input.off('input.venueAC').on('input.venueAC', function() {
                var q = $(this).val().trim();
                clearTimeout(_venueDebounce);
                $dd.empty().hide();
                $('.manual-address-toggle-wrap').hide();
                if (q.length < 2) return;
                _venueDebounce = setTimeout(function() {
                    $.ajax({
                        url: '/api/public/places/autocomplete',
                        data: { input: q },
                        success: function(data) {
                            $dd.empty();
                            var predictions = data.predictions || [];
                            if (predictions.length === 0) {
                                // No matches (or the Places API itself is unavailable) — don't leave
                                // the user stuck with a dead search box; offer manual entry instead.
                                $dd.hide();
                                $('.manual-address-toggle-wrap').show();
                                return;
                            }
                            predictions.slice(0, 6).forEach(function(p) {
                                var main = p.main_text || p.description || '';
                                var sec  = p.secondary_text || '';
                                $('<div class="vdd-item">').html(
                                    '<span class="vdd-main">' + $('<span>').text(main).html() + '</span>' +
                                    (sec ? '<span class="vdd-sec">' + $('<span>').text(sec).html() + '</span>' : '')
                                ).on('mousedown', function(e) {
                                    e.preventDefault();
                                    $.ajax({
                                        url: '/api/public/places/details',
                                        data: { place_id: p.place_id },
                                        success: function(detailData) {
                                            if (!detailData || !detailData.result) {
                                                $input.val(main);
                                                $dd.hide();
                                                $('.manual-address-toggle-wrap').show();
                                                return;
                                            }
                                            var place = detailData.result;
                                            $input.val(place.name || main);
                                            $('#venuePlaceId').val(p.place_id || '');
                                            $('#bookAddress').val(place.formatted_address || '');
                                            var city = '', country = '', prov = '';
                                            (place.address_components || []).forEach(function(c) {
                                                if (c.types.includes('locality') || c.types.includes('sublocality_level_1')) city = c.long_name;
                                                else if (c.types.includes('administrative_area_level_1')) prov = c.long_name;
                                                else if (c.types.includes('country')) country = c.long_name;
                                            });
                                            if (city) $('#bookCity').val(city);
                                            else if (prov) $('#bookCity').val(prov);
                                            if (country) $('#bookCountry').val(country);
                                            $input.removeClass('bk-input--err');
                                            $('#err-bookLocation').hide();
                                            $dd.hide();
                                            $('.manual-address-toggle-wrap').show();
                                        },
                                        error: function() {
                                            $input.val(main);
                                            $dd.hide();
                                            $('.manual-address-toggle-wrap').show();
                                        }
                                    });
                                }).appendTo($dd);
                            });
                            $dd.show();
                        },
                        error: function() {
                            $dd.hide();
                            $('.manual-address-toggle-wrap').show();
                        }
                    });
                }, 250);
            });

            $input.off('keydown.venueAC').on('keydown.venueAC', function(e) {
                if (e.key === 'Escape') { $dd.hide(); return; }
                if (e.key === 'ArrowDown' && $dd.is(':visible')) {
                    e.preventDefault();
                    var $i = $dd.find('.vdd-item'), $c = $i.filter('.vdd-active');
                    ($c.length ? $c.removeClass('vdd-active').next() : $i.first()).addClass('vdd-active');
                }
                if (e.key === 'ArrowUp' && $dd.is(':visible')) {
                    e.preventDefault();
                    var $i = $dd.find('.vdd-item'), $c = $i.filter('.vdd-active');
                    ($c.length ? $c.removeClass('vdd-active').prev() : $i.last()).addClass('vdd-active');
                }
                if (e.key === 'Enter' && $dd.is(':visible')) {
                    var $a = $dd.find('.vdd-active');
                    ($a.length ? $a : $dd.find('.vdd-item:first')).trigger('mousedown');
                }
            });

            $(document).off('click.venueAC').on('click.venueAC', function(ev) {
                if (!$(ev.target).closest('#bookLocation, #venueDropdown').length) $dd.hide();
            });
        }

        // Wire up immediately
        initAutocomplete();

        // --- BOOKING ATTACHMENT STATE ---
        var bookingFiles = [];

        $(document).on('click', '#bookAttachZone', function(e) {
            if (e.target.id !== 'bookAttachInput') $('#bookAttachInput').trigger('click');
        });

        $(document).on('change', '#bookAttachInput', function() {
            addFiles(Array.from(this.files));
            this.value = '';
        });

        $(document).on('dragover', '#bookAttachZone', function(e) {
            e.preventDefault();
            $(this).css('border-color', '#D4AF37');
        });
        $(document).on('dragleave drop', '#bookAttachZone', function(e) {
            $(this).css('border-color', '#2a2a2a');
        });
        $(document).on('drop', '#bookAttachZone', function(e) {
            e.preventDefault();
            addFiles(Array.from(e.originalEvent.dataTransfer.files));
        });

        function addFiles(newFiles) {
            var allowed = /\.(pdf|doc|docx|jpg|jpeg|png|webp)$/i;
            var rejected = [];
            newFiles.forEach(function(f) {
                if (!allowed.test(f.name)) {
                    rejected.push('"' + f.name + '" (unsupported type)');
                    return;
                }
                if (f.size > 10 * 1024 * 1024) {
                    rejected.push('"' + f.name + '" (exceeds 10 MB limit)');
                    return;
                }
                if (bookingFiles.length >= 5) {
                    rejected.push('"' + f.name + '" (max 5 files reached)');
                    return;
                }
                bookingFiles.push(f);
            });
            if (rejected.length) {
                if (window.notificationService) {
                    window.notificationService.showWarning('Attachment Error', 'The following file(s) could not be attached:\n\n' + rejected.join('\n'));
                } else {
                    alert('The following file(s) could not be attached:\n\n' + rejected.join('\n'));
                }
            }
            renderAttachList();
        }

        function renderAttachList() {
            var $list = $('#bookAttachList');
            $list.empty();
            bookingFiles.forEach(function(f, idx) {
                $list.append(
                    $('<div>').css({display:'flex',alignItems:'center',gap:'6px',background:'#111',border:'1px solid #2a2a2a',borderRadius:'5px',padding:'5px 10px',fontSize:'12px',color:'#ccc'})
                        .append($('<i>').addClass('fa-solid fa-file').css({color:'#D4AF37',fontSize:'11px'}))
                        .append($('<span>').text(f.name).css({flex:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',maxWidth:'180px'}))
                        .append($('<span>').text('(' + (f.size/1024).toFixed(0) + ' KB)').css({color:'#555',fontSize:'11px'}))
                        .append($('<button>').attr('type','button').html('<i class="fa-solid fa-xmark"></i>').css({background:'none',border:'none',color:'#666',cursor:'pointer',padding:'0 2px'}).on('click', (function(i) { return function() { bookingFiles.splice(i, 1); renderAttachList(); }; })(idx)))
                );
            });
        }

        var _bkDraftFields = ['bookEventName','bookType','bookDate','bookName','bookEmail','bookCell',
            'bookCompany','bookLocation','bookAddress','bookCity',
            'bookCountry','bookAudience','bookDemographic','bookTravel','bookNotes'];

        function saveBkDraft() {
            try {
                var draft = { step: currentStep, fields: {}, services: [], savedAt: Date.now() };
                _bkDraftFields.forEach(function(id) { draft.fields[id] = $('#' + id).val() || ''; });

                // Persist the services table so it survives a modal close/reopen
                $('#bkServicesTableBody tr').each(function() {
                    var $row = $(this);
                    var svcId = $row.data('svc-id');
                    // Look up the live catalogue entry for accurate meta; fall back to row data
                    var catalogueEntry = _bkServicesCatalogue.find(function(s) { return String(s.id) === String(svcId); }) || {};
                    draft.services.push({
                        id:         svcId,
                        name:       catalogueEntry.name || $row.find('td:first div div div:first').text().trim(),
                        unitPrice:  parseFloat($row.data('unit-price')) || 0,
                        qty:        parseInt($row.find('.bk-svc-qty').val()) || 1,
                        model:      $row.data('model') || 'flat_fee',
                        minQty:     parseInt($row.data('min-qty')) || 1,
                        unit:       catalogueEntry.display_unit || '',
                        meta: {
                            performance_length_minutes: parseInt($row.data('perf-mins')) || 0,
                            travel_included:            catalogueEntry.travel_included || false,
                            booking_lead_time_days:     parseInt(catalogueEntry.booking_lead_time_days) || 0,
                            availability_rule:          catalogueEntry.availability_rule || ''
                        }
                    });
                });

                localStorage.setItem('bkDraft', JSON.stringify(draft));
                $('#bkDraftStatus').stop(true).fadeIn(300).delay(2000).fadeOut(600);
                $('#bkClearDraftBtn').show();
                serverSyncBkDraft();
            } catch(e) {}
        }

        // =====================================================================
        // BOOKING RECOVERY — server-side draft autosave (abandoned-cart capture)
        //  Piggybacks on the existing localStorage draft; only syncs once a valid
        //  email exists (POPIA minimisation). consent_given mirrors #bookPopia.
        // =====================================================================
        var _bkFurthestStep = 1;
        var _bkServerSyncTimer = null;

        function getBkDraftToken() {
            try {
                var t = localStorage.getItem('bkDraftToken');
                if (!t) {
                    t = (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
                        : 'd' + Date.now() + Math.random().toString(16).slice(2);
                    localStorage.setItem('bkDraftToken', t);
                }
                return t;
            } catch (e) { return 'd' + Date.now(); }
        }

        function bkEmailValid() {
            return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(($('#bookEmail').val() || '').trim());
        }

        function buildBkDraftPayload() {
            var srv = [];
            $('#bkServicesTableBody tr').each(function () {
                var svcId = $(this).data('svc-id');
                var cat = _bkServicesCatalogue.find(function (s) { return String(s.id) === String(svcId); }) || {};
                srv.push({ service_id: svcId, name: cat.name || '', quantity: parseInt($(this).find('.bk-svc-qty').val()) || 1 });
            });
            return {
                draft_token: getBkDraftToken(),
                current_step: currentStep || 1,
                furthest_step: Math.max(_bkFurthestStep, currentStep || 1),
                name: $('#bookName').val(), company: $('#bookCompany').val(), email: $('#bookEmail').val(),
                cell: $('#bookCell').val(), event_name: $('#bookEventName').val(), event_date: $('#bookDate').val(),
                event_type: $('#bookType').val(), event_location: $('#bookLocation').val(),
                venue_address: $('#bookAddress').val(), city: $('#bookCity').val(), country: $('#bookCountry').val(),
                venue_type: $('#bookVenueType').val(), performance_slot: $('#bookSlot').val(),
                performance_duration: (typeof getBkDurationMins === 'function' ? getBkDurationMins() : ''),
                message: $('#bookNotes').val(),
                services: srv,
                consent_given: $('#bookPopia').is(':checked'),
                source: window._bkSource || 'direct'
            };
        }

        // Debounced background sync (used while the user is active in the form).
        function serverSyncBkDraft() {
            if (!bkEmailValid()) return;
            clearTimeout(_bkServerSyncTimer);
            _bkServerSyncTimer = setTimeout(function () {
                try {
                    fetch('/api/public/bookings/draft', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(buildBkDraftPayload()),
                        bypassInterceptor: true
                    }).catch(function () {});
                } catch (e) {}
            }, 1200);
        }

        // Best-effort flush on exit (modal close / tab hidden / unload) via sendBeacon.
        function flushBkDraft() {
            if (!bkEmailValid()) return;
            try {
                var blob = new Blob([JSON.stringify(buildBkDraftPayload())], { type: 'application/json' });
                if (navigator.sendBeacon) navigator.sendBeacon('/api/public/bookings/draft', blob);
            } catch (e) {}
        }

        // Resume a saved draft from an email link (?resume=token): rebuild the
        // localStorage draft in the existing format, then let the show.bs.modal
        // restore path rehydrate fields + services before jumping to the saved step.
        function initBkResume() {
            var params = new URLSearchParams(window.location.search || '');
            var token = params.get('resume');
            if (!token) return;
            fetch('/api/public/bookings/draft/' + encodeURIComponent(token), { bypassInterceptor: true })
                .then(function (r) { return r.ok ? r.json() : null; })
                .then(function (data) {
                    if (!data || !data.success || !data.draft) return;
                    var d = data.draft, attempts = 0;
                    (function build() {
                        var catReady = _bkServicesCatalogue && _bkServicesCatalogue.length;
                        if (!catReady && attempts++ < 12) { return setTimeout(build, 250); }
                        var fields = {
                            bookEventName: d.event_name || '', bookType: d.event_type || '', bookDate: d.event_date || '',
                            bookName: d.name || '', bookEmail: d.email || '', bookCell: d.cell || '', bookCompany: d.company || '',
                            bookLocation: d.event_location || '', bookAddress: d.venue_address || '', bookCity: d.city || '',
                            bookCountry: d.country || '', bookNotes: d.message || ''
                        };
                        var services = [];
                        (d.services || []).forEach(function (s) {
                            var cat = (_bkServicesCatalogue || []).find(function (c) { return String(c.id) === String(s.service_id); });
                            if (!cat) return;
                            services.push({
                                id: cat.id, name: cat.name,
                                unitPrice: parseFloat(cat.base_price != null ? cat.base_price : cat.default_price) || 0,
                                qty: parseInt(s.quantity) || 1, model: cat.pricing_model || 'flat_fee',
                                minQty: parseInt(cat.min_quantity) || 1, unit: cat.display_unit || '',
                                meta: {
                                    performance_length_minutes: parseInt(cat.performance_length_minutes) || 0,
                                    travel_included: cat.travel_included || false,
                                    booking_lead_time_days: parseInt(cat.booking_lead_time_days) || 0,
                                    availability_rule: cat.availability_rule || ''
                                }
                            });
                        });
                        var target = Math.min(4, Math.max(1, parseInt(d.furthest_step) || 1));
                        _bkFurthestStep = target;
                        try {
                            localStorage.setItem('bkDraft', JSON.stringify({ step: target, fields: fields, services: services, savedAt: Date.now() }));
                            if (d.draft_token) localStorage.setItem('bkDraftToken', d.draft_token);
                        } catch (e) {}
                        $('#bookingModal').modal('show');
                        setTimeout(function () { if (typeof updateProgress === 'function') updateProgress(target); }, 700);
                        try {
                            if (history.replaceState) {
                                params.delete('resume');
                                history.replaceState({}, '', window.location.pathname + (params.toString() ? '?' + params.toString() : '') + window.location.hash);
                            }
                        } catch (e) {}
                    })();
                }).catch(function () {});
        }

        function updateProgress(step) {
            // Update dots
            $('.book-step-dot').each(function() {
                var s = parseInt($(this).data('step'));
                $(this).removeClass('active done');
                if (s === step) $(this).addClass('active');
                else if (s < step) $(this).addClass('done');
            });
            // Update progress line
            var pct = ((step - 1) / 3) * 100;
            $('#bookingProgressLine').css('width', pct + '%');
            // Show step panel
            $('.book-step-panel').removeClass('active');
            $('#bookStep' + step).addClass('active');
            currentStep = step;
            _bkFurthestStep = Math.max(_bkFurthestStep, step);
            // Wait past the 350ms tmFadeIn animation before measuring input position
            if (step === 3) {
                setTimeout(initAutocomplete, 450);
                // P6: Always show the duration readout when entering Step 3 so the user
                // can see and adjust the duration BEFORE selecting a time slot.
                // If a slot is already chosen show the real time; otherwise show a hint.
                if (!$('#bkSlotFrom').val()) {
                    $('#bkReadoutText').html(
                        '<span style="color:#888;font-size:var(--fs-sm);font-style:italic;">Select a time slot below</span>'
                    );
                }
                $('#bkSmartReadout').css('display', 'flex');
            }
            // Persist step progress so a closed modal can be restored
            if (step > 0) saveBkDraft();
        }
        window._bkGoTo = updateProgress;

        function setFieldState(id, valid, msg) {
            var $inp = $('#' + id);
            var $err = $('#err-' + id);
            if (valid) {
                $inp.removeClass('bk-input--err').addClass('bk-input--ok');
                $inp.removeAttr('aria-invalid');
                $inp.removeAttr('aria-describedby');
                $err.hide();
            } else {
                $inp.removeClass('bk-input--ok').addClass('bk-input--err');
                if (msg) $err.html('<i class="fa-solid fa-triangle-exclamation" style="margin-right:4px;"></i>' + msg);
                $inp.attr('aria-invalid', 'true');
                if ($err.length) {
                    $inp.attr('aria-describedby', 'err-' + id);
                }
                $err.show();
            }
            return valid;
        }

        function validateStep(step) {
            var ok = true;

            if (step === 1) {
                // Event name — at least 3 chars
                var evName = $('#bookEventName').val().trim();
                if (evName.length < 3) {
                    ok = setFieldState('bookEventName', false, 'Please enter an event name (at least 3 characters).') && ok;
                } else {
                    setFieldState('bookEventName', true);
                }

                // Event type
                var evType = $('#bookType').val();
                if (!evType) {
                    ok = setFieldState('bookType', false, 'Please select the type of event so we can tailor Thabiso\'s performance.') && ok;
                } else {
                    setFieldState('bookType', true);
                }

                // Services — at least one row
                if ($('#bkServicesTableBody tr').length === 0) {
                    $('#err-bookServices').html('<i class="fa-solid fa-triangle-exclamation" style="margin-right:4px;"></i>Please add at least one service. Use the catalogue dropdown above to browse options.').show();
                    $('#bkServiceDropdown').addClass('bk-input--err').attr('aria-invalid', 'true').attr('aria-describedby', 'err-bookServices');
                    ok = false;
                } else {
                    $('#err-bookServices').hide();
                    $('#bkServiceDropdown').removeClass('bk-input--err').removeAttr('aria-invalid').removeAttr('aria-describedby');
                }

                // Date — availability is gated by bookNext1 (checks dateAvailable).
                // setDateStatus() owns all date field feedback; don't double-show via setFieldState.
                var dateVal = $('#bookDate').val();
                if (!dateVal) {
                    setDateStatus('warn', 'Please select the event date before continuing.');
                    $('#bookDate').addClass('bk-input--err').attr('aria-invalid', 'true').attr('aria-describedby', 'hint-bookDate');
                    $('#bookDateDisplay').addClass('bk-input--err');
                    ok = false;
                } else {
                    // Guard: event date must not be in the past
                    var _today = new Date(); _today.setHours(0, 0, 0, 0);
                    var _selected = new Date(dateVal);
                    if (_selected < _today) {
                        setDateStatus('error', 'Event date cannot be in the past. Please select a future date.');
                        $('#bookDate').addClass('bk-input--err').attr('aria-invalid', 'true').attr('aria-describedby', 'hint-bookDate');
                        $('#bookDateDisplay').addClass('bk-input--err');
                        ok = false;
                    } else if (!dateAvailable) {
                        $('#bookDate').addClass('bk-input--err').attr('aria-invalid', 'true').attr('aria-describedby', 'hint-bookDate');
                        $('#bookDateDisplay').addClass('bk-input--err');
                        ok = false;
                    } else {
                        $('#bookDate').removeClass('bk-input--err').removeAttr('aria-invalid').removeAttr('aria-describedby');
                        $('#bookDateDisplay').removeClass('bk-input--err');
                    }
                }
            }

            else if (step === 2) {
                // Full name — at least 3 chars
                var nameVal = $('#bookName').val().trim();
                if (nameVal.length < 3) {
                    ok = setFieldState('bookName', false, 'Please enter your full name (first and last name, at least 3 characters).') && ok;
                } else {
                    setFieldState('bookName', true);
                }

                // Email — proper format (require real TLD of 2+ alphabetical chars)
                var emailVal = $('#bookEmail').val().trim();
                var emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
                if (!emailRe.test(emailVal)) {
                    ok = setFieldState('bookEmail', false, 'Please enter a valid email address (e.g. name@company.com). Your quote will be sent here.') && ok;
                } else {
                    setFieldState('bookEmail', true);
                }

                // Phone — strip non-digits, must be 10–15 digits (SA numbers are always ≥10)
                var cellVal = $('#bookCell').val().trim();
                var cellDigits = cellVal.replace(/\D/g, '');
                if (cellDigits.length < 10 || cellDigits.length > 15) {
                    ok = setFieldState('bookCell', false, 'Please enter a valid phone number (10–15 digits). South African: 082 123 4567 or +27 82 123 4567.') && ok;
                } else {
                    setFieldState('bookCell', true);
                }

            }

            else if (step === 3) {
                // Location — at least 3 chars (skipped for Virtual Events)
                var isVirtual = $('#bookType').val() === 'Virtual Event';
                if (isVirtual) {
                    if (!$('#bookLocation').val().trim()) $('#bookLocation').val('Virtual / Online');
                    setFieldState('bookLocation', true);
                } else {
                    var locVal = $('#bookLocation').val().trim();
                    if (locVal.length < 3) {
                        ok = setFieldState('bookLocation', false, 'Please enter the venue or location name (at least 3 characters).') && ok;
                    } else {
                        setFieldState('bookLocation', true);
                    }
                }

                // Performance slot — required
                var slotVal = $('#bookSlot').val().trim();
                if (!slotVal) {
                    $('#err-bookSlot').text('Please select a performance time slot.').show();
                    $('#bkTimeSlotsGrid').addClass('bk-input--err').attr('aria-invalid', 'true').attr('aria-describedby', 'err-bookSlot');
                    ok = false;
                } else {
                    $('#err-bookSlot').hide();
                    $('#bkTimeSlotsGrid').removeClass('bk-input--err').removeAttr('aria-invalid').removeAttr('aria-describedby');
                    // Check for conflicts with busy ranges
                    var slotFrom = $('#bkSlotFrom').val();
                    var slotTo = $('#bkSlotTo').val();
                    if (slotFrom && slotTo && currentBusyRanges && currentBusyRanges.length > 0) {
                        var conflict = currentBusyRanges.some(function(r) { return slotFrom < r.end && r.start < slotTo; });
                        if (conflict) {
                            $('#err-bookSlot').text('This time slot overlaps with a blocked period. Please choose another slot.').show();
                            $('#bkTimeSlotsGrid').addClass('bk-input--err').attr('aria-invalid', 'true').attr('aria-describedby', 'err-bookSlot');
                            ok = false;
                        }
                    }
                }

                // Notes — optional (C3). Encouraged but never blocks the booking.
                setFieldState('bookNotes', true);
            }

            if (!ok) {
                var $firstErr = $('#bookStep' + step).find('.bk-input--err').first();
                if ($firstErr.length) {
                    $firstErr[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
                    if ($firstErr.is('#bkTimeSlotsGrid')) {
                        $firstErr.attr('tabindex', '-1');
                    }
                    $firstErr.focus();
                }
            }

            return ok;
        }

        function buildReview() {
            var srvHtml = '';
            $('#bkServicesTableBody tr').each(function() {
                var name = $(this).find('td:first').text().trim();
                var qty = parseInt($(this).find('.bk-svc-qty').val()) || 0;
                var model = $(this).data('model');
                var qtyDisp = model === 'per_minute' ? formatDuration(qty) : qty;
                srvHtml += '<div style="margin-bottom:5px;font-size:12px;"><strong>' + name + '</strong> (' + qtyDisp + ')</div>';
            });
            // P8: Include Venue Name and Company so the user can verify the
            // two most critical identifiers on the Review screen before submitting.
            var rows = [
                ['Event Name',            $('#bookEventName').val()],
                ['Event Type',            $('#bookType').val()],
                ['Services Required',     srvHtml || '\u2014'],
                ['Event Date',            $('#bookDate').val()],
                ['Performance Slot',      $('#bookSlot').val() || '\u2014'],
                ['Venue / Location',      $('#bookLocation').val() || '\u2014'],
                ['Venue Type',            $('#bookVenueType').val() || '\u2014'],
                ['Notes / Requirements',  $('#bookNotes').val() || '\u2014'],
                ['Audience Size',         $('#bookAudience').val() || '\u2014'],
                ['Audience Demographic',  $('#bookDemographic').val() || '\u2014'],
                ['Full Name',             $('#bookName').val()],
                ['Company / Organization', $('#bookCompany').val() || '\u2014'],
                ['Email',                 $('#bookEmail').val()],
                ['Phone',                 $('#bookCell').val()],
                ['City / Country',        [$('#bookCity').val(), $('#bookCountry').val()].filter(Boolean).join(', ') || '\u2014'],
                ['Travel & Accommodation', $('#bookTravel').val() || '\u2014']
            ];
            var html = rows.map(function(r) {
                return '<div class="book-review-row"><span>' + r[0] + '</span><span>' + (r[1] || '\u2014') + '</span></div>';
            }).join('');
            $('#bookReviewContent').html(html);
        }

        // Note: bookNext1 click is registered near the date availability checker (with availability gating).

        // Collapsible manual address toggle — text reflects open/closed state
        $(document).on('click', '#toggleManualAddress', function(e) {
            e.preventDefault();
            var $row = $('#manualAddressRow');
            var isOpen = $row.is(':visible');
            $row.slideToggle(200);
            $(this).html(isOpen
                ? '<i class="fa-solid fa-pen-to-square"></i> Edit address details manually'
                : '<i class="fa-solid fa-magnifying-glass"></i> Back to venue search'
            );
        });

        // Event type change: disable/enable Step 3 location fields dynamically if Virtual Event
        $(document).on('change', '#bookType', function() {
            var val = $(this).val();
            var isVirtual = val === 'Virtual Event';
            var $fieldsToDisable = $('#bookLocation, #bookVenueType, #bookAddress, #bookCity, #bookCountry, #bookAudience, #bookDemographic, #bookTravel');
            
            if (isVirtual) {
                $fieldsToDisable.prop('disabled', true).addClass('bk-input--disabled');
                $('#bookLocation').val('Virtual / Online');
                $('#bookTravel').val('Not required');
                $('#manualAddressRow').hide();
                $('#toggleManualAddress').closest('.manual-address-toggle-wrap').hide();
                // Update step 3 heading for virtual context
                $('#bookStep3 .bk-step-title').text('Performance Slot & Requirements');
                $('#bookStep3 .bk-step-desc').text('Choose your preferred time slot, share event notes, and upload any supporting files. Venue fields are not applicable for virtual events.');
            } else {
                $fieldsToDisable.prop('disabled', false).removeClass('bk-input--disabled');
                if ($('#bookLocation').val() === 'Virtual / Online') {
                    $('#bookLocation').val('');
                }
                if ($('#bookTravel').val() === 'Not required') {
                    $('#bookTravel').val('');
                }
                if ($('#venuePlaceId').val()) {
                    // Re-show toggle if autocomplete was used
                    $('#toggleManualAddress').closest('.manual-address-toggle-wrap').show();
                }
                // Restore default step 3 heading
                $('#bookStep3 .bk-step-title').text('Venue & Requirements');
                $('#bookStep3 .bk-step-desc').text('Where is the event and what does Thabiso need to know?');
            }
        });

        var _bkDupCache = null; // C3: { key:'email|date', clash } — reuse the email-blur check on Next
        $('#bookNext2').on('click', async function() {
            var $btn = $(this);
            if ($btn.prop('disabled')) return;

            if (!validateStep(2)) return;

            var email = $('#bookEmail').val().trim();
            var chosenDate = $('#bookDate').val();
            if (!chosenDate || !email) return;

            var dupKey = email + '|' + chosenDate;
            var clash = null;
            if (_bkDupCache && _bkDupCache.key === dupKey) {
                // Already validated this email+date on blur — skip the redundant round-trip (C3).
                clash = _bkDupCache.clash;
            } else {
                $btn.prop('disabled', true).html('<i class="fa fa-spinner fa-spin"></i> Checking...');
                try {
                    var dupRes = await fetch('/api/public/bookings/lookup', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ email: email })
                    });
                    var dupData = await dupRes.json();
                    if (dupData.success && dupData.bookings) {
                        clash = dupData.bookings.find(function(b) {
                            var bStatus = (b.status || '').toUpperCase();
                            return b.date === chosenDate && bStatus !== 'CANCELLED' && bStatus !== 'EXPIRED';
                        });
                    }
                    _bkDupCache = { key: dupKey, clash: clash || null };
                } catch(e) {
                    // network error — don't block
                }
                $btn.prop('disabled', false).html('Venue Details <i class="fa-solid fa-arrow-right"></i>');
            }

            // The duplicate guard is preserved: a true same-day clash still blocks here
            // (and the server re-enforces it at submit). Only the redundant network hop is gone.
            if (clash) {
                setFieldState('bookEmail', false, 'You already have an active booking on this date (#' + clash.id + '). Only one same-day booking is allowed.');
                $('#bookingFormError')
                    .html('<i class="fa-solid fa-circle-xmark" style="margin-right:6px;color:#ef5350;"></i>' +
                          'Duplicate booking detected: You already have an active booking on this date (<strong>#' + clash.id + '</strong>' +
                          (clash.event_name ? ' — ' + clash.event_name : '') + '). ' +
                          'Please choose another date or <a href="#" id="trackDuplicateBtn2" style="color:var(--y-base);text-decoration:underline;">track booking #' + clash.id + ' &rarr;</a>')
                    .css('background', 'rgba(239,83,80,0.08)')
                    .show();
                $('#trackDuplicateBtn2').off('click').on('click', function(e) {
                    e.preventDefault();
                    $('#bookingModal').modal('hide');
                    setTimeout(function() {
                        $('#trackId').val(clash.id);
                        $('#trackEmail').val(email);
                        $('#trackingModal').modal('show');
                    }, 400);
                });
                return;
            }

            updateProgress(3);
            setTimeout(renderTimeSlots, 400);
        });
        $('#bookNext3').on('click', function() { if (validateStep(3)) { buildReview(); updateProgress(4); } });
        $('#bookBack2').on('click', function() { updateProgress(1); });
        $('#bookBack3').on('click', function() { updateProgress(2); });
        $('#bookBack4').on('click', function() {
            updateProgress(3);
        });

        // Real-time: clear error + remove red border as soon as user starts correcting
        $bookingForm.on('input change', '[id^="book"]', function() {
            var id = this.id;
            var val = $(this).val().trim();
            // Only remove the error state if the field now has content
            if (val) {
                $(this).removeClass('bk-input--err');
                $('#err-' + id).hide();
                if (id === 'bookDate') $('#bookDateDisplay').removeClass('bk-input--err');
            }
            // Live notes hint — optional field (C3); soft, never alarming.
            if (id === 'bookNotes') {
                $('#hint-bookNotes').text('').css('color', '');
                if (val.length) $('#bookNotes').removeClass('bk-input--err').addClass('bk-input--ok');
                $('#err-bookNotes').hide();
            }
        });

        $bookingForm.on('change', '#bkServicesTableBody', function() {
            if ($('#bkServicesTableBody tr').length > 0) {
                $('#err-bookServices').hide();
            }
        });

        // Blur validation — show errors as soon as user leaves a field
        $bookingForm.on('blur', '#bookEventName', function() {
            var v = $(this).val().trim();
            if (v && v.length < 3) setFieldState('bookEventName', false, 'Event name must be at least 3 characters.');
            else if (v.length >= 3) setFieldState('bookEventName', true);
        });

$bookingForm.on('blur', '#bookName', function() {
            var v = $(this).val().trim();
            if (v && v.length < 3) setFieldState('bookName', false, 'Please enter your full name (at least 3 characters).');
            else if (v.length >= 3) setFieldState('bookName', true);
        });

        $bookingForm.on('blur', '#bookEmail', async function() {
            var v = $(this).val().trim();
            if (!v) return;
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) {
                setFieldState('bookEmail', false, 'Please enter a valid email address (e.g. name@company.com).');
                return;
            }
            setFieldState('bookEmail', true);

            var chosenDate = $('#bookDate').val();
            if (!chosenDate) return;
            $('#bookingFormError').hide().css('background', ''); // clear any previous hint
            try {
                var dupRes = await fetch('/api/public/bookings/lookup', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email: v })
                });
                var dupData = await dupRes.json();
                if (dupData.success && dupData.bookings) {
                    var clash = dupData.bookings.find(function(b) {
                        var bStatus = (b.status || '').toUpperCase();
                        return b.date === chosenDate && bStatus !== 'CANCELLED' && bStatus !== 'EXPIRED';
                    });
                    _bkDupCache = { key: v + '|' + chosenDate, clash: clash || null }; // C3: let Next reuse this
                    if (clash) {
                        setFieldState('bookEmail', false, 'You already have an active booking on this date (#' + clash.id + '). Only one same-day booking is allowed.');
                        $('#bookingFormError')
                            .html('<i class="fa-solid fa-circle-xmark" style="margin-right:6px;color:#ef5350;"></i>' +
                                  'Duplicate booking detected: You already have an active booking on this date (<strong>#' + clash.id + '</strong>' +
                                  (clash.event_name ? ' — ' + clash.event_name : '') + '). ' +
                                  'Please choose another date or <a href="#" id="trackDuplicateBtn" style="color:var(--y-base);text-decoration:underline;">track booking #' + clash.id + ' &rarr;</a>')
                            .css('background', 'rgba(239,83,80,0.08)')
                            .show();
                        
                        $('#trackDuplicateBtn').off('click').on('click', function(e) {
                            e.preventDefault();
                            $('#bookingModal').modal('hide');
                            setTimeout(function() {
                                $('#trackId').val(clash.id);
                                $('#trackEmail').val(v);
                                $('#trackingModal').modal('show');
                            }, 400);
                        });
                    }
                }
            } catch(e) { /* silent — informational only */ }
        });

        $bookingForm.on('blur', '#bookCell', function() {
            var v = $(this).val().trim();
            if (!v) return;
            var digits = v.replace(/\D/g, '');
            if (digits.length < 10 || digits.length > 15) setFieldState('bookCell', false, 'Please enter a valid phone number (10–15 digits). e.g. 082 123 4567 or +27 82 123 4567.');
            else setFieldState('bookCell', true);
        });


        $bookingForm.on('blur', '#bookLocation', function() {
            var v = $(this).val().trim();
            if (v && v.length < 3) setFieldState('bookLocation', false, 'Venue name must be at least 3 characters.');
            else if (v.length >= 3) setFieldState('bookLocation', true);
        });

        var isSubmitting = false;

        $bookingForm.on('submit', async function(e) {
            e.preventDefault();
            
            var $submitBtn = $('#bookSubmitBtn');
            var $label = $('#bookSubmitBtnLabel');
            if ($submitBtn.prop('disabled')) return;
            $submitBtn.prop('disabled', true).css('opacity', '0.7');
            var origLabelHtml = $label.html();
            $label.html('<i class="fa fa-spinner fa-spin" style="margin-right:8px;"></i>Submitting&hellip;');

            if (isSubmitting) return;
            
            // Check POPIA manually to avoid native form validation bleeds
            if (!$('#bookPopia').is(':checked')) {
                $('#bookingFormError').html('<i class="fa-solid fa-triangle-exclamation" style="margin-right:6px;"></i>You must confirm that your details are accurate and consent to the Privacy Policy before submitting. Please tick the checkbox above.').show();
                $('#bookingFormError')[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
                $submitBtn.prop('disabled', false).css('opacity', '1');
                $label.html(origLabelHtml);
                return;
            }

            isSubmitting = true;
            $('#bookingFormError').hide();

            // Re-fetch service prices and warn if any changed since the form was opened
            try {
                var freshSvcs = await fetch('/api/public/services').then(function(r) { return r.json(); });
                if (Array.isArray(freshSvcs)) {
                    var priceChanged = freshSvcs.some(function(s) {
                        var cached = _bkServicesCatalogue.find(function(c) { return c.id === s.id; });
                        return cached && parseFloat(cached.default_price) !== parseFloat(s.default_price);
                    });
                    if (priceChanged) {
                        _bkServicesCatalogue = freshSvcs;
                        isSubmitting = false;
                        $submitBtn.prop('disabled', false);
                        $label.text('Submit Booking Request');
                        window.notificationService.showWarning('Prices Updated', 'Service prices have changed since you opened this form. Please review the updated total before submitting.');
                        return;
                    }
                }
            } catch(priceErr) { /* non-blocking — proceed with cached prices */ }

            var srvItems = [];
            $('#bkServicesTableBody tr').each(function() {
                srvItems.push({
                    service_id: parseInt($(this).data('svc-id')),
                    quantity_minutes: parseInt($(this).find('.bk-svc-qty').val()) || 0
                });
            });

            var submitData = {
                name: $('#bookName').val().trim(),
                company: $('#bookCompany').val().trim(),
                email: $('#bookEmail').val().trim(),
                cell: $('#bookCell').val().trim(),
                event_name: $('#bookEventName').val().trim(),
                event_date: $('#bookDate').val(),
                performance_slot: $('#bookSlot').val().trim(),
                performance_duration: getBkDurationMins(),
                event_location: $('#bookLocation').val().trim(),
                venue_address: $('#bookAddress').val().trim(),
                venuePlaceId: $('#venuePlaceId').val().trim(),
                city: $('#bookCity').val().trim(),
                country: $('#bookCountry').val().trim(),
                venue_type: $('#bookVenueType').val(),
                event_type: $('#bookType').val(),
                audience_size: $('#bookAudience').val().trim(),
                audience_demographic: $('#bookDemographic').val().trim(),
                travel_accommodation: $('#bookTravel').val() || null,
                message: $('#bookNotes').val().trim(),
                services: srvItems,
                popia_consent: $('#bookPopia').is(':checked'),
                policy_version: 'v2.2',
                source: window._bkSource || 'direct',
                referrer: document.referrer ? document.referrer.substring(0, 255) : null,
                draft_token: getBkDraftToken()
            };

            try {
                var response = await fetch('/api/public/bookings', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(submitData),
                    bypassInterceptor: true
                });
                var result = await response.json();

                if (response.ok && result.success) {
                    // Show success screen
                    $('#bookingStepBar').hide();
                    $('.book-step-panel').hide();
                    const bookingRef = '#' + (result.booking_id || '\u2014');

                    // Step 2: upload attachments if any were selected
                    if (bookingFiles.length > 0 && result.booking_id) {
                        var fd = new FormData();
                        fd.append('email', submitData.email);
                        bookingFiles.forEach(function(f) { fd.append('attachments', f); });
                        try {
                            await fetch('/api/public/bookings/' + result.booking_id + '/attachments', {
                                method: 'POST',
                                body: fd,
                                bypassInterceptor: true
                            });
                        } catch (attachErr) {
                            console.warn('Attachment upload failed (booking saved):', attachErr);
                        }
                        bookingFiles = [];
                        renderAttachList();
                    }

                    $('#bookSuccessId').text(bookingRef);
                    $('#bookSuccessScreen').show();
                    $bookingForm[0].reset();
                    // Booking Recovery: clear the local draft + token so a completed booking isn't re-counted as abandoned.
                    try { localStorage.removeItem('bkDraft'); localStorage.removeItem('bkDraftToken'); } catch(e) {}
                    // C2: remember contact details for a faster next booking — only with POPIA consent.
                    try {
                        if (submitData.popia_consent) {
                            localStorage.setItem('bkClientInfo', JSON.stringify({
                                name: submitData.name || '', email: submitData.email || '',
                                cell: submitData.cell || '', company: submitData.company || ''
                            }));
                        }
                    } catch(e) {}
                    _bkFurthestStep = 1;
                    $('#bkDraftBanner').remove();
                    $('#bkPrefillNote').remove();

                    // Wire up "Track this booking" button
                    $('#goToTrackBtn').off('click').on('click', function() {
                        $('#bookingModal').modal('hide');
                        setTimeout(function() {
                            $('#trackId').val(result.booking_id);
                            $('#trackEmail').val(submitData.email);
                            $('#trackingModal').modal('show');
                        }, 400);
                    });

                    // Wire up copy button
                    $('#copyBookingIdBtn').off('click').on('click', function () {
                        navigator.clipboard.writeText(bookingRef).then(() => {
                            const $btn = $(this);
                            $btn.html('<i class="fa-solid fa-check"></i> Copied!');
                            setTimeout(() => $btn.html('<i class="fa-regular fa-copy"></i> Copy ID'), 2000);
                        }).catch(() => {
                            // Clipboard API blocked — fallback
                            const el = document.createElement('textarea');
                            el.value = bookingRef;
                            document.body.appendChild(el);
                            el.select();
                            document.execCommand('copy');
                            document.body.removeChild(el);
                            const $btn = $(this);
                            $btn.html('<i class="fa-solid fa-check"></i> Copied!');
                            setTimeout(() => $btn.html('<i class="fa-regular fa-copy"></i> Copy ID'), 2000);
                        });
                    });
                } else if (result.existing_id) {
                    // Duplicate booking: same email + date already has an active booking
                    var existingId = result.existing_id;
                    var $errBox = $('#bookingFormError');
                    $errBox.html(
                        '<i class="fa-solid fa-triangle-exclamation" style="margin-right:6px;"></i>' +
                        (result.message || 'You already have an active booking for this date.') +
                        ' <a href="#" id="trackDuplicateBtn" style="color:var(--y-base);text-decoration:underline;">Track booking #' + existingId + ' &rarr;</a>'
                    ).show();
                    $('#trackDuplicateBtn').off('click').on('click', function(e) {
                        e.preventDefault();
                        $('#bookingModal').modal('hide');
                        setTimeout(function() {
                            $('#trackId').val(existingId);
                            $('#trackEmail').val($('#bookEmail').val().trim());
                            $('#trackingModal').modal('show');
                        }, 400);
                    });
                    isSubmitting = false;
                    $submitBtn.prop('disabled', false);
                    $label.html(origLabelHtml);
                } else {
                    throw new Error(result.message || 'Failed to submit booking request.');
                }
            } catch (error) {
                console.error('Booking Submission Error:', error);
                
                var msg = error.message || 'An unexpected error occurred. Please try again.';
                var mapped = false;
                
                // Server-side validation error mapping
                if (msg.includes('Name must be') || msg.includes('full name')) {
                    setFieldState('bookName', false, msg);
                    mapped = true;
                } else if (msg.includes('email address') || msg.includes('Email')) {
                    setFieldState('bookEmail', false, msg);
                    mapped = true;
                } else if (msg.includes('phone number') || msg.includes('Cell')) {
                    setFieldState('bookCell', false, msg);
                    mapped = true;
                } else if (msg.includes('date') || msg.includes('selected date')) {
                    if (typeof setDateStatus === 'function') {
                        setDateStatus(false, msg);
                    } else {
                        setFieldState('bookDate', false, msg);
                    }
                    mapped = true;
                } else if (msg.includes('time slot') || msg.includes('overlap')) {
                    // time slot overlap
                    $('#err-bookSlot').text(msg).show();
                    $('#bkTimeSlotsGrid').addClass('bk-input--err').attr('aria-invalid', 'true').attr('aria-describedby', 'err-bookSlot');
                    mapped = true;
                } else if (msg.includes('message') || msg.includes('characters')) {
                    setFieldState('bookNotes', false, msg);
                    mapped = true;
                } else if (msg.includes('POPIA')) {
                    $('#bookingFormError').html('<i class="fa-solid fa-triangle-exclamation" style="margin-right:6px;"></i>' + msg).show();
                    mapped = true;
                } else if (msg.includes('service') || msg.includes('Service')) {
                    $('#err-bookServices').html('<i class="fa-solid fa-triangle-exclamation" style="margin-right:4px;"></i>' + msg).show();
                    $('#bkServiceDropdown').addClass('bk-input--err').attr('aria-invalid', 'true').attr('aria-describedby', 'err-bookServices');
                    mapped = true;
                } else if (msg.includes('location') || msg.includes('venue')) {
                    setFieldState('bookLocation', false, msg);
                    mapped = true;
                }
                
                if (mapped) {
                    // Redirect to the correct wizard step
                    var targetStep = 1;
                    var errId = null;
                    if ($('.bk-input--err').length) {
                        errId = $('.bk-input--err').first().attr('id');
                    } else if ($('#bkTimeSlotsGrid').hasClass('bk-input--err')) {
                        errId = 'bookSlot';
                    } else if ($('#bkServiceDropdown').hasClass('bk-input--err')) {
                        errId = 'bookServices';
                    }
                    
                    if (errId) {
                        if (['bookName', 'bookEmail', 'bookCell', 'bookCompany'].includes(errId)) {
                            targetStep = 2;
                        } else if (['bookLocation', 'bookVenueType', 'bookSlot', 'bookNotes', 'bookAudience', 'bookDemographic', 'bookTravel'].includes(errId)) {
                            targetStep = 3;
                        } else if (['bookDate', 'bookServices'].includes(errId)) {
                            targetStep = 1;
                        }
                        updateProgress(targetStep);
                        
                        // Focus the element after transition
                        setTimeout(function() {
                            if (errId === 'bookSlot') {
                                $('#bkTimeSlotsGrid').focus();
                            } else if (errId === 'bookServices') {
                                $('#bkServiceDropdown').focus();
                            } else {
                                $('#' + errId).focus();
                            }
                        }, 300);
                    }
                    window.notificationService.showWarning('Validation Failed', 'Please check the highlighted fields and try again.');
                } else {
                    window.notificationService.showError(msg);
                }

                isSubmitting = false;
                $submitBtn.prop('disabled', false);
                $label.html(origLabelHtml);
            }
        });

        // Track which entry point opened the booking modal (Gap 12: source attribution)
        window._bkSource = 'direct';
        $('[data-toggle="modal"][data-target="#bookingModal"]').on('click', function() {
            window._bkSource = $(this).data('bk-source') || 'direct';
        });

        // C1: when a visitor books from a specific service card, pre-add the matching
        // catalogue service so they don't re-pick it. Best-effort keyword match; safe
        // no-op when there's no confident match (they just add manually, as today).
        var _bkSourceKeywords = {
            'service-standup':   ['stand-up', 'standup', 'stand up', 'stand'],
            'service-mc-host':   ['mc /', 'mc/', 'hosting', 'compere', 'master of cere', ' host'],
            'service-tv-film':   ['tv', 'podcast', 'film', 'present', 'acting', 'screen'],
            'service-voiceover': ['voice', 'narration']
        };
        function bkPreselectServiceFromSource() {
            try {
                // Never clobber a restored draft or an existing manual selection.
                if ($('#bkServicesTableBody tr').length) return;
                var keywords = _bkSourceKeywords[window._bkSource];
                if (!keywords || !Array.isArray(_bkServicesCatalogue) || !_bkServicesCatalogue.length) return;
                var svc = _bkServicesCatalogue.find(function(s) {
                    if (!s || !s.name) return false;
                    var n = String(s.name).toLowerCase();
                    return keywords.some(function(k) { return n.indexOf(k) !== -1; });
                });
                if (!svc) return;
                var perfMins = parseInt(svc.performance_length_minutes) || 0;
                var startQty = svc.pricing_model === 'per_minute'
                    ? (perfMins || parseInt(svc.min_quantity) || 60)
                    : (svc.pricing_model === 'per_hour' ? Math.ceil((perfMins || 60) / 60) : 1);
                bkAddServiceRow(svc.id, svc.name, parseFloat(svc.default_price) || 0, startQty, svc.pricing_model, svc.min_quantity, svc.display_unit, svc);
                if (typeof bkSyncDurationSelect === 'function') bkSyncDurationSelect();
            } catch (e) { /* non-fatal — visitor selects manually */ }
        }

        // C2: prefill contact details from the visitor's last (consented) booking, with a
        // Clear control. Only fills empty fields — never overrides a restored draft.
        function bkPrefillClientInfo() {
            try {
                if ($('#bookName').val() || $('#bookEmail').val()) return; // draft already populated these
                var info = JSON.parse(localStorage.getItem('bkClientInfo') || 'null');
                if (!info || !info.email) return;
                $('#bookName').val(info.name || '');
                $('#bookEmail').val(info.email || '');
                $('#bookCell').val(info.cell || '');
                $('#bookCompany').val(info.company || '');
                $('#bkPrefillNote').remove();
                $('#bookStep2 .bk-step-header').after(
                    '<div id="bkPrefillNote" style="background:rgba(74,222,128,0.06);border:1px solid rgba(74,222,128,0.16);' +
                    'color:#4ade80;font-size:12px;padding:7px 12px;margin:0 0 12px;border-radius:6px;' +
                    'display:flex;justify-content:space-between;align-items:center;gap:8px;">' +
                    '<span><i class="fa-solid fa-user-check" style="margin-right:6px;"></i>' +
                    'Prefilled from your last request &mdash; edit anything that changed.</span>' +
                    '<a href="#" id="bkClearPrefill" style="color:#4ade80;font-size:11px;text-decoration:underline;white-space:nowrap;">Clear</a>' +
                    '</div>'
                );
            } catch (e) { /* non-fatal */ }
        }
        $(document).on('click', '#bkClearPrefill', function(e) {
            e.preventDefault();
            try { localStorage.removeItem('bkClientInfo'); } catch(err) {}
            $('#bookName, #bookEmail, #bookCell, #bookCompany').val('');
            $('#bkPrefillNote').remove();
        });

        // Refresh calendar each time the modal opens; restore any in-progress draft
        $('#bookingModal').on('show.bs.modal', function() {
            if (window.refreshAvailCalendar) window.refreshAvailCalendar();
            try {
                var raw = localStorage.getItem('bkDraft');
                if (raw) {
                    var draft = JSON.parse(raw);
                    if (draft && draft.fields) {
                        Object.keys(draft.fields).forEach(function(id) {
                            var val = draft.fields[id];
                            if (val) $('#' + id).val(val);
                        });

                        // Trigger change to update UI for Virtual Event or other dynamically controlled fields
                        $('#bookType').trigger('change');

                        // Re-run availability check so dateAvailable is restored after modal reopen
                        if (draft.fields.bookDate) {
                            var $disp = $('#bookDateDisplay');
                            if ($disp.length) {
                                $disp.text(draft.fields.bookDate).addClass('bk-date-display--filled');
                            }
                            $('#bookDate').trigger('change');
                        }

                        // P5: Restore services table from draft so the user doesn't
                        // need to re-add services after closing and reopening the modal.
                        if (Array.isArray(draft.services) && draft.services.length > 0) {
                            // Clear any leftover rows from a previous session
                            $('#bkServicesTableBody').empty();
                            $('#bkServicesTableWrap').hide();
                            draft.services.forEach(function(s) {
                                bkAddServiceRow(
                                    s.id,
                                    s.name,
                                    parseFloat(s.unitPrice) || 0,
                                    parseInt(s.qty) || 1,
                                    s.model || 'flat_fee',
                                    parseInt(s.minQty) || 1,
                                    s.unit || '',
                                    s.meta || {}
                                );
                            });
                            bkSyncDurationSelect();
                        }

                        $('#bkClearDraftBtn').show();
                        // Draft restoration banner with timestamp
                        $('#bkDraftBanner').remove();
                        var _savedAt = draft.savedAt ? new Date(draft.savedAt) : null;
                        var _timeLabel = _savedAt
                            ? ' — saved ' + _savedAt.toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' })
                            : '';
                        $('#bkDraftStatus').closest('div').before(
                            '<div id="bkDraftBanner" style="' +
                            'background:rgba(96,165,250,0.06);border:1px solid rgba(96,165,250,0.15);' +
                            'color:#60a5fa;font-size:12px;padding:7px 12px;margin:0 0 4px;border-radius:6px;' +
                            'display:flex;justify-content:space-between;align-items:center;gap:8px;">' +
                            '<span><i class="fa-solid fa-floppy-disk" style="margin-right:6px;"></i>' +
                            'Draft restored' + _timeLabel + '.</span>' +
                            '<a href="#" id="clearDraftFromBanner" style="color:#60a5fa;font-size:11px;text-decoration:underline;white-space:nowrap;">' +
                            'Clear &amp; start fresh</a>' +
                            '</div>'
                        );
                    } else {
                        $('#bkClearDraftBtn').hide();
                    }
                } else {
                    $('#bkClearDraftBtn').hide();
                }
            } catch(e) {
                localStorage.removeItem('bkDraft');
                $('#bkClearDraftBtn').hide();
            }
            // C2: prefill returning-visitor contact details (when no draft populated them).
            bkPrefillClientInfo();
            // C1: pre-add the service matching the card the visitor came from.
            bkPreselectServiceFromSource();
            updateProgress(1);
        });

        // Reset wizard when modal closes (draft intentionally preserved for reopen)
        $('#bookingModal').on('hidden.bs.modal', function() {
            _venueInited = false; // allow fresh init + event rebind next open
            isSubmitting = false;
            $bookingForm[0].reset();
            $('.manual-address-toggle-wrap').hide();
            $('#bkServicesTableBody').empty();
            $('#bkServicesTableWrap').hide();
            updateProgress(1);
            $('#bookingStepBar').show();
            $('#bookSuccessScreen').hide();
            $('.bk-step-err').hide();
            $('#bookingFormError').hide();
            $('#dedicatedBookingForm .bk-input').removeClass('bk-input--err bk-input--ok bk-input--disabled').prop('disabled', false);
            $('#hint-bookNotes').text('');
            $('#bookSubmitBtn').prop('disabled', false);
            $('#bookSubmitBtnLabel').text('Submit Booking Request');
            // Reset date availability gate
            dateAvailable = false;
            $('#bookNext1').prop('disabled', false); // allow typing; re-gate on date change
            setDateStatus('clear');
            $('#bookDateDisplay').text('No date selected — pick one from the calendar below.').removeClass('bk-date-display--filled bk-input--err');
            $('#bkClearDraftBtn').hide();
            $('#bkDraftBanner').remove();
            $('#bkPrefillNote').remove();
        });

        function _clearBookingDraft() {
            try { localStorage.removeItem('bkDraft'); } catch(e) {}
            $bookingForm[0].reset();
            $('#bkServicesTableBody').empty();
            $('#bkServicesTableWrap').hide();
            $('#bookingFormError').hide();
            $('#dedicatedBookingForm .bk-input').removeClass('bk-input--err bk-input--ok bk-input--disabled').prop('disabled', false);
            $('#hint-bookNotes').text('');
            dateAvailable = false;
            $('#bookNext1').prop('disabled', false);
            setDateStatus('clear');
            $('.bk-service-card').removeClass('selected');
            $('#bkDraftStatus').hide();
            $('#bkClearDraftBtn').hide();
            $('#bkDraftBanner').remove();
            $('#bkPrefillNote').remove();
            updateProgress(1);
        }

        $(document).on('click', '#bkClearDraftBtn', async function(e) {
            e.preventDefault();
            const confirmed = window.notificationService ? await window.notificationService.showConfirm({
                title: 'Clear Progress',
                message: 'Are you sure you want to clear your saved progress and start over?',
                isDestructive: true
            }) : confirm('Are you sure you want to clear your saved progress and start over?');
            if (confirmed) {
                _clearBookingDraft();
            }
        });

        // Banner "Clear & start fresh" link — same action, no confirm dialog (inline context is clear enough)
        $(document).on('click', '#clearDraftFromBanner', function(e) {
            e.preventDefault();
            _clearBookingDraft();
        });

        // ---- Booking Recovery wiring ----
        // Live background sync as the user types (debounced + email-gated inside serverSyncBkDraft).
        $bookingForm.on('input change', 'input, textarea, select', serverSyncBkDraft);
        // Capture latest progress when the visitor leaves before submitting.
        $('#bookingModal').on('hide.bs.modal', flushBkDraft);
        $(window).on('beforeunload', flushBkDraft);
        document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') flushBkDraft(); });
        // Resume-from-email-link support (?resume=token).
        initBkResume();
    }


    // ==========================================
    // INITIALIZE ADMIN BACKGROUNDS AND CLEANUP
    // ==========================================
    // Clean up legacy localStorage preferences now superseded by server-side branding settings.
    localStorage.removeItem('tm_theme_font');
    localStorage.removeItem('tm_login_bg');
    localStorage.removeItem('tm_dashboard_bg');

    // Apply the server-persisted admin login background (set on window.tmLoginBg by the
    // public-branding fetch in admin.html). Shown on the sign-in screen; cleared on the dashboard.
    window.applyAdminBackgrounds = function() {
        if (!document.body.classList.contains('admin-body') && !document.body.classList.contains('login-page-bg')) return;

        var dashSec = document.getElementById('dashboardSection');
        var isDashboard = dashSec && (dashSec.style.display !== 'none');
        var loginBg = window.tmLoginBg || null;

        if (!isDashboard && loginBg) {
            document.body.style.setProperty('background-image', 'url("' + loginBg + '")', 'important');
            document.body.style.setProperty('background-size', 'cover', 'important');
            document.body.style.setProperty('background-position', 'center', 'important');
            document.body.style.setProperty('background-attachment', 'fixed', 'important');
            document.body.style.setProperty('background-repeat', 'no-repeat', 'important');
            document.body.style.setProperty('min-height', '100vh', 'important');
        } else {
            // Dashboard, or no custom login background set — fall back to the CSS default.
            document.body.style.backgroundImage = '';
        }
    };

    // Apply backgrounds initially when loading the page (re-run after branding fetch resolves).
    setTimeout(window.applyAdminBackgrounds, 100);

    // ==========================================
    // ADMIN DASHBOARD SIDEBAR LOGIC
    // ==========================================
    var $tmSidebar = $('#tmAdminSidebar');
    var $tmSidebarToggle = $('#tmSidebarToggle');
    var $tmMobileToggle = $('#tmMobileAdminOpen');
    var $tmSidebarOverlay = $('#tmSidebarOverlay');
    var $adminSidebarTabs = $('.admin-sidebar li[role="presentation"] a');

    if ($tmSidebar.length) {
        $tmSidebarToggle.on('click', function() {
            $tmSidebar.toggleClass('collapsed');
        });

        $tmMobileToggle.on('click', function() {
            $tmSidebar.addClass('mobile-open');
            $tmSidebarOverlay.addClass('show');
        });

        $tmSidebarOverlay.on('click', function() {
            $tmSidebar.removeClass('mobile-open');
            $tmSidebarOverlay.removeClass('show');
        });

        $adminSidebarTabs.on('click', function() {
            if ($(window).width() <= 768) {
                $tmSidebar.removeClass('mobile-open');
                $tmSidebarOverlay.removeClass('show');
            }
        });
    }

    /* ── Mobile Search Panel Toggle ── */
    (function() {
        var $searchBtn   = $('#admMobileSearchBtn');
        var $searchClose = $('#admMobileSearchClose');
        var $panel       = $('#admMobileSearchPanel');
        var $input       = $('#admMobileSearchInput');

        function openSearch() {
            $panel.addClass('open').attr('aria-hidden', 'false');
            $searchBtn.attr('aria-expanded', 'true');
            // Slight delay so the CSS transition plays before focus
            setTimeout(function() { $input.focus(); }, 100);
        }

        function closeSearch() {
            $panel.removeClass('open').attr('aria-hidden', 'true');
            $searchBtn.attr('aria-expanded', 'false');
            $input.val('');
        }

        $searchBtn.on('click', function() {
            if ($panel.hasClass('open')) { closeSearch(); } else { openSearch(); }
        });

        $searchClose.on('click', closeSearch);

        // Close on Escape
        $(document).on('keydown', function(e) {
            if (e.key === 'Escape' && $panel.hasClass('open')) { closeSearch(); }
        });

        // Close when clicking outside the panel (but not on the trigger)
        $(document).on('click', function(e) {
            if ($panel.hasClass('open') &&
                !$(e.target).closest('#admMobileSearchPanel').length &&
                !$(e.target).closest('#admMobileSearchBtn').length) {
                closeSearch();
            }
        });
    })();

});
window.onbeforeunload = function() {
    sessionStorage.setItem('index_scrollpos', window.scrollY);
};

// === PUBLIC AVAILABILITY CALENDAR ===
(function() {
    var MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

    var state = { year: 0, month: 0, held: [], booked: [], loading: false, nonWorkingDows: [] };

    function pad(n) { return n < 10 ? '0' + n : '' + n; }

    function toDateStr(d) {
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    }

    var _workingDaysFetched = false;
    function fetchWorkingDays(cb) {
        if (_workingDaysFetched) { cb(); return; }
        Promise.all([0,1,2,3,4,5,6].map(function(d) {
            return fetch('/api/public/booking-config?dow=' + d)
                .then(function(r) { return r.json(); })
                .catch(function() { return { is_working_day: true }; });
        })).then(function(configs) {
            _workingDaysFetched = true;
            state.nonWorkingDows = [];
            configs.forEach(function(cfg, idx) {
                if (cfg.is_working_day === false) state.nonWorkingDows.push(idx);
            });
            cb();
        }).catch(function() {
            _workingDaysFetched = true;
            cb();
        });
    }

    function fetchAndRender() {
        if (state.loading) return;
        state.loading = true;
        document.getElementById('calTitle').textContent = MONTHS[state.month - 1] + ' ' + state.year;

        fetch('/api/public/availability/month?year=' + state.year + '&month=' + state.month)
            .then(function(r) { return r.json(); })
            .then(function(data) {
                state.held   = data.held   || [];
                state.booked = data.booked || [];
                renderGrid();
                state.loading = false;
            })
            .catch(function() {
                state.held = []; state.booked = [];
                renderGrid();
                state.loading = false;
            });
    }

    function renderGrid() {
        var grid = document.getElementById('calDaysGrid');
        if (!grid) return;

        var today = new Date(); today.setHours(0,0,0,0);
        var todayStr = toDateStr(today);
        var firstDow = new Date(state.year, state.month - 1, 1).getDay();
        var daysInMonth = new Date(state.year, state.month, 0).getDate();
        var cells = [];

        for (var blank = 0; blank < firstDow; blank++) {
            cells.push('<div class="tm-cal-cell tm-cal-cell--empty" aria-hidden="true"></div>');
        }

        for (var d = 1; d <= daysInMonth; d++) {
            var ds    = state.year + '-' + pad(state.month) + '-' + pad(d);
            var date  = new Date(state.year, state.month - 1, d);
            var isPast      = date < today;
            var isToday     = ds === todayStr;
            var isHeld      = state.held.indexOf(ds) >= 0;
            var isBooked    = state.booked.indexOf(ds) >= 0;
            var isNonWorking = !isPast && state.nonWorkingDows.indexOf(date.getDay()) >= 0;

            var cls = 'tm-cal-cell';
            var tip = '';
            var clickable = false;

            if (isPast) {
                cls += ' tm-cal-cell--past';
                tip = 'Past date';
            } else if (isNonWorking) {
                cls += ' tm-cal-cell--nonworking';
                tip = 'Not a working day';
            } else if (isHeld) {
                cls += ' tm-cal-cell--held';
                tip = 'Blocked';
            } else if (isBooked) {
                cls += ' tm-cal-cell--booked';
                tip = 'Reserved — additional booking requests welcomed';
                clickable = true;
            } else {
                cls += ' tm-cal-cell--avail';
                tip = 'Available for booking';
                clickable = true;
            }
            if (isToday)   cls += ' tm-cal-cell--today';
            if (clickable) cls += ' tm-cal-cell--clickable';

            var role   = clickable ? 'button' : 'presentation';
            var tabIdx = clickable ? '0' : '-1';
            cells.push(
                '<div class="' + cls + '" data-date="' + ds + '" title="' + tip + '" role="' + role + '" tabindex="' + tabIdx + '" aria-label="' + ds + ': ' + tip + '">' + d + '</div>'
            );
        }

        grid.innerHTML = cells.join('');

        // Bind click + keyboard on clickable cells
        Array.prototype.forEach.call(grid.querySelectorAll('.tm-cal-cell--clickable'), function(el) {
            el.addEventListener('click', function() {
                // Highlight selected cell with green border
                Array.prototype.forEach.call(grid.querySelectorAll('.tm-cal-cell--selected'), function(prev) {
                    prev.classList.remove('tm-cal-cell--selected');
                });
                el.classList.add('tm-cal-cell--selected');
                openBookingWithDate(el.getAttribute('data-date'));
            });
            el.addEventListener('keydown', function(e) {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    Array.prototype.forEach.call(grid.querySelectorAll('.tm-cal-cell--selected'), function(prev) {
                        prev.classList.remove('tm-cal-cell--selected');
                    });
                    el.classList.add('tm-cal-cell--selected');
                    openBookingWithDate(el.getAttribute('data-date'));
                }
            });
        });
        // Re-apply selected class if date is already chosen (e.g. month navigation)
        var _existingDate = document.getElementById('bookDate') ? document.getElementById('bookDate').value : null;
        if (_existingDate) {
            var _selCell = grid.querySelector('.tm-cal-cell--clickable[data-date="' + _existingDate + '"]');
            if (_selCell) _selCell.classList.add('tm-cal-cell--selected');
        }
    }

    function openBookingWithDate(ds) {
        var inp = document.getElementById('bookDate');
        if (inp) {
            inp.value = ds;
            var disp = document.getElementById('bookDateDisplay');
            if (disp) {
                disp.textContent = ds;
                disp.classList.add('bk-date-display--filled');
                disp.classList.remove('bk-input--err');
            }
            // Fire jQuery change so the existing availability pre-check runs
            if (typeof $ !== 'undefined') $('#bookDate').trigger('change');
        }
    }

    function init() {
        var calEl = document.getElementById('availabilityCalendar');
        if (!calEl) return;

        var now = new Date();
        state.year  = now.getFullYear();
        state.month = now.getMonth() + 1;

        var prevBtn = document.getElementById('calPrev');
        var nextBtn = document.getElementById('calNext');

        prevBtn.addEventListener('click', function() {
            var d = new Date(state.year, state.month - 2, 1);
            var nowFloor = new Date(); nowFloor.setDate(1); nowFloor.setHours(0,0,0,0);
            if (d < nowFloor) return; // don't navigate to past months
            state.year  = d.getFullYear();
            state.month = d.getMonth() + 1;
            fetchAndRender();
        });

        nextBtn.addEventListener('click', function() {
            var d = new Date(state.year, state.month, 1); // next month
            state.year  = d.getFullYear();
            state.month = d.getMonth() + 1;
            fetchAndRender();
        });

        fetchWorkingDays(function() { fetchAndRender(); });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // Allow other scripts to force-refresh (e.g. after admin action)
    window.refreshAvailCalendar = function() {
        if (typeof state !== 'undefined') {
            state.held = []; state.booked = [];
            fetchAndRender();
        }
    };

    // --- AUTO-FILL TRACKING MODAL FROM URL ---
    const urlParams = new URLSearchParams(window.location.search);
    const trackId = urlParams.get('track');
    const trackEmail = urlParams.get('email');
    const trackAction = urlParams.get('action');

    if (trackId) {
        $('#trackId').val(trackId);
        if (trackEmail) $('#trackEmail').val(trackEmail);

        // Show the modal
        $('#trackingModal').modal('show');

        // Trigger search automatically if both are present
        if (trackEmail) {
            setTimeout(() => {
                $('#trackBtn').click();
                // S2-8: Deep-link to the Accept button when action=accept
                if (trackAction === 'accept') {
                    setTimeout(() => {
                        const $section = $('#acceptQuoteSection');
                        if ($section.is(':visible')) {
                            $section[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
                            $section.css({ outline: '2px solid #D4AF37', borderRadius: '4px', transition: 'outline 1.5s ease' });
                            setTimeout(() => $section.css({ outline: '', borderRadius: '' }), 3000);
                        }
                    }, 2000);
                }
            }, 500);
        }
    }
})();
