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

    // Reveals `htmls` into $grid 8 at a time, with "View More" / "View Less" buttons underneath —
    // shared by Gallery and Past Shows (the two public grids whose count is unbounded admin content;
    // Upcoming Shows is deliberately never paginated — hiding a time-sensitive show behind a click
    // is the wrong tradeoff there). More reveals the next 8; Less collapses straight back to the
    // first 8 (not back one page — "go back to 8 pictures", not a step-by-step undo). Each button
    // hides itself when it would have nothing to do (More once everything is shown, Less at the
    // first page) rather than the whole control disappearing — collapsing is always on offer once
    // there's more than a page. Idempotent: clears any control left over from a previous call on the
    // same $grid, so a section that gets re-rendered later doesn't end up with two.
    function tmPaginateGrid($grid, htmls, opts) {
        opts = opts || {};
        var pageSize = opts.pageSize || 8;
        $grid.nextAll('.tm-view-more-wrap').first().remove();
        if (htmls.length <= pageSize) {
            htmls.forEach(function (html) { $grid.append(html); });
            if ('IntersectionObserver' in window && typeof revealObserver !== 'undefined') {
                $grid.children('.reveal').each(function () { revealObserver.observe(this); });
            } else {
                $grid.children('.reveal').addClass('active');
            }
            return;
        }

        var shown = pageSize;
        var $more = $('<button type="button" class="btn btn-outline tm-view-more"></button>')
            .text(opts.moreLabel || 'View More')
            .attr('aria-label', opts.moreAriaLabel || opts.moreLabel || 'View more');
        var $less = $('<button type="button" class="btn btn-outline tm-view-less"></button>')
            .text(opts.lessLabel || 'View Less')
            .attr('aria-label', opts.lessAriaLabel || opts.lessLabel || 'View less');
        var $wrap = $('<div class="tm-view-more-wrap"></div>').append($more).append($less);

        function render() {
            $grid.empty();
            htmls.slice(0, shown).forEach(function (html) { $grid.append(html); });
            if ('IntersectionObserver' in window && typeof revealObserver !== 'undefined') {
                $grid.children('.reveal').each(function () { revealObserver.observe(this); });
            } else {
                $grid.children('.reveal').addClass('active');
            }
            var moreVisible = shown < htmls.length;
            // Only ever both false at once if this grid had <= pageSize items to begin with — the
            // early return above means that case never reaches here, so this is belt-and-braces.
            var lessVisible = shown > pageSize;
            var focusStranded = (document.activeElement === $more[0] && !moreVisible) || (document.activeElement === $less[0] && !lessVisible);
            // .toggleClass, not .toggle() — .btn forces display:inline-flex with !important, which
            // beats the plain inline display:none .toggle() would set (see .tm-hidden in redesign.css).
            $more.toggleClass('tm-hidden', !moreVisible);
            $less.toggleClass('tm-hidden', !lessVisible);
            if (focusStranded) {
                // Land focus on whichever control is still there to receive it, rather than letting
                // it fall back to <body> right as the visitor clicked.
                if (moreVisible) $more.trigger('focus');
                else if (lessVisible) $less.trigger('focus');
                else $grid.attr('tabindex', '-1').trigger('focus');
            }
        }
        $more.on('click', function () { shown = Math.min(htmls.length, shown + pageSize); render(); });
        $less.on('click', function () {
            shown = pageSize;
            render();
            if ($wrap[0].scrollIntoView) $wrap[0].scrollIntoView({ block: 'nearest' });
        });

        render();
        $grid.after($wrap);
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
        $grid.nextAll('.tm-view-more-wrap').first().remove();

        if (galleryItems.length === 0) {
            $grid.append('<p class="text-center" style="width: 100%; color: #999;">The gallery is currently empty.</p>');
            return;
        }

        var htmls = galleryItems.map(function(item) {
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

            return `
                <div class="insta-item reveal">
                    ${mediaHtml}
                </div>
            `;
        });

        // Shows the first 8, with View More / View Less for the rest (tmPaginateGrid, above).
        tmPaginateGrid($grid, htmls, {
            moreLabel: 'View More Photos', moreAriaLabel: 'View more gallery photos',
            lessLabel: 'View Less Photos', lessAriaLabel: 'View less gallery photos, back to the first 8'
        });
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
        accolades:  { sel: '#accolades',   nav: ['#accolades'] },
        footprint:  { sel: '#footprint',   nav: ['#footprint'] },
        team:       { sel: '#team',        nav: ['#team'] },
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

        // `opts.paginate` (used for Past Shows only — Upcoming Shows always shows everything,
        // never hidden behind a click) shows the first 8 with a "View More" button for the rest.
        function populateGrid($grid, items, emptyMessage, opts) {
            if ($grid.length === 0) return;
            $grid.empty();
            $grid.nextAll('.tm-view-more-wrap').first().remove();

            if (items.length === 0) {
                $grid.append('<p class="text-center" style="width: 100%; color: #999;">' + emptyMessage + '</p>');
                return;
            }

            var htmls = items.map(function(item) {
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

                return `
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
            });

            if (opts && opts.paginate) {
                tmPaginateGrid($grid, htmls, { moreLabel: opts.moreLabel, moreAriaLabel: opts.moreAriaLabel, lessLabel: opts.lessLabel, lessAriaLabel: opts.lessAriaLabel });
            } else {
                htmls.forEach(function(html) { $grid.append(html); });
                if ('IntersectionObserver' in window && typeof revealObserver !== 'undefined') {
                    $grid.find('.live-event-card.reveal').each(function() { revealObserver.observe(this); });
                }
            }
        }

        populateGrid($upcomingGrid, upcomingEvents, "No upcoming events at the moment.");
        populateGrid($pastGrid, pastEvents, "No past events at the moment.", {
            paginate: true,
            moreLabel: 'View More Shows', moreAriaLabel: 'View more past shows',
            lessLabel: 'View Less Shows', lessAriaLabel: 'View less past shows, back to the first 8'
        });

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
    function msYouTubeThumb(videoId) {
        // Same derivation the admin Career editor uses so a video milestone shows its poster frame
        // even while collapsed, and behind the player before it finishes loading.
        return 'https://img.youtube.com/vi/' + videoId + '/hqdefault.jpg';
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
        $opt.addClass('is-playing');
        $opt.append('<div class="ms-option__embed"><iframe src="' + embedUrl + '" referrerpolicy="strict-origin-when-cross-origin" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>' + watchLinkHtml + '</div>');
    }

    function msWireInteractions() {
        var $row = $('#milestonesRow');
        $row.off('click.milestones keydown.milestones');

        // A click on a collapsed panel only expands it, showing its YouTube poster + play badge —
        // never autoplays. A click on the panel that's already expanded is the "play" action: it
        // embeds and starts the video (if there is one and it hasn't started already). This applies
        // uniformly, including the panel that's active by default on page load.
        $row.on('click.milestones', '.ms-option', function() {
            var $opt = $(this);
            if ($opt.hasClass('is-active')) {
                if ($opt.attr('data-embed-url') && !$opt.find('.ms-option__embed').length) msEmbedVideo($opt);
                return;
            }
            $row.find('.ms-option').removeClass('is-active is-playing').attr('aria-expanded', 'false').find('.ms-option__embed').remove();
            $opt.addClass('is-active').attr('aria-expanded', 'true');
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
                // The API's own order is admin-entry order (display_order is unused/null today,
                // so it falls back to created_at DESC), which has no relation to the highlight's
                // year. The public timeline reads oldest-to-newest, so re-sort by year here —
                // undated items (no parsable year) sort after all dated ones, oldest first among themselves.
                parsed = data.slice().sort(function(a, b) {
                    var ya = parseInt(a.year, 10), yb = parseInt(b.year, 10);
                    var na = isNaN(ya), nb = isNaN(yb);
                    if (na && nb) return 0;
                    if (na) return 1;
                    if (nb) return -1;
                    return ya - yb;
                });
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
            var media = item.image_path || '';
            var mediaType = 'none';
            var embedUrl = null;
            var watchUrl = null;
            var thumbUrl = null;

            if (media) {
                if (media.startsWith('data:image') || media.match(/\.(jpeg|jpg|gif|png|webp)$/i) != null) {
                    mediaType = 'image';
                } else if (media.includes('youtube.com') || media.includes('youtu.be') || media.includes('embed/')) {
                    var ytId = msYouTubeVideoId(media);
                    if (ytId) {
                        mediaType = 'video';
                        embedUrl = msYouTubeEmbedUrl(ytId);
                        watchUrl = 'https://www.youtube.com/watch?v=' + ytId;
                        thumbUrl = msYouTubeThumb(ytId);
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
            else if (mediaType === 'video' && thumbUrl) $opt.css('background-image', 'url("' + thumbUrl + '")');

            $opt.append('<div class="ms-option__wash"></div>');
            if (item.year) $opt.append('<div class="ms-option__collapsed-year">' + item.year + '</div>');
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
            // The first panel starts expanded (is-active) without going through the click handler,
            // but its video should NOT autoplay on page load — it shows the YouTube poster and a
            // play badge, and only embeds once the visitor clicks it (handled in msWireInteractions).
        });

        msWireInteractions();
    }

    renderCareer();

    // 9a2. Accolades & Recognition — wins, nominations and honours. WHAT is published and in WHICH
    // order is decided by lib/accolades.js (the admin portal uses the same module); HOW it looks is
    // js/accolades-view.js, the same renderer as the admin's live preview. With nothing published the
    // section and its nav links stay hidden — it never shows placeholder awards.
    async function renderAccolades() {
        var $section = $('#accolades');
        if (!$section.length || !window.AccoladesView) return;
        var items = [];
        try {
            const response = await fetch('/api/public/accolades');
            const data = await response.json();
            if (Array.isArray(data)) items = data;
        } catch (err) {
            console.error("Failed to load accolades from server:", err);
        }

        var $nav = $('.tm-navlinks a[href="#accolades"]').closest('li').add('.tm-mobile-menu a[href="#accolades"]');
        if (!items.length) {
            $section.prop('hidden', true);
            $nav.addClass('tm-nav-empty');
            return;
        }

        var $ledger = $('#accoladesLedger');
        AccoladesView.mount({
            items: items,
            $ledger: $ledger,
            $filters: $('#accoladesFilters'),
            $status: $('#accoladesStatus'),
            onOpen: function (item) {
                $('#accoladeDrawerTitle').text(item.title || 'Recognition');
                AccoladesView.renderDetail(item, $('#accoladeDrawerBody'));
                if (window.openAtlDrawer) openAtlDrawer('accoladeDrawer');
            }
        });
        $nav.removeClass('tm-nav-empty');
        // If applySectionVisibility() already ran, its .toggle(true) met these links while
        // .tm-nav-empty was hiding them, and jQuery left its default inline display behind
        // (display:inline on the mobile <a>, which undoes the menu's block styling). Clear it —
        // unless the admin switched the section off, when that inline display:none must stay.
        if (!$section.hasClass('tm-section-hidden')) $nav.css('display', '');
        $section.prop('hidden', false);

        // First render reveals entry by entry on scroll, like the Footprint cards (a filter change
        // re-draws them with their own enter animation instead — see .acc-entry--enter).
        var $entries = $ledger.children('.acc-entry').addClass('tm-reveal reveal');
        if ('IntersectionObserver' in window && typeof revealObserver !== 'undefined') {
            $entries.each(function () { revealObserver.observe(this); });
        } else {
            $entries.addClass('active');
        }
    }
    renderAccolades();

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

    // 9b2. Dynamic Management Team Rendering — photo grid + member list, hover/tap highlight.
    // The photo grid is decorative (aria-hidden); the list beside it is the accessible source of
    // truth (name + role always visible, social links revealed on active — reachable by mouse,
    // touch and keyboard alike, not hover-only).
    async function renderTeam() {
        var members = [];
        try {
            const response = await fetch('/api/public/team');
            const data = await response.json();
            if (Array.isArray(data)) members = data;
        } catch (err) {
            console.error("Failed to load team members from server:", err);
        }

        var $layout = $('#teamLayout');
        if (!$layout.length) return;

        if (!members.length) {
            $layout.closest('.tm-section').hide();
            return;
        }

        // All DOM building and hover/tap behaviour lives in js/team-view.js — the same module the
        // admin portal's live preview renders with, so the two can never look different.
        var $photos = $('#teamPhotoGrid');
        var $list = $('#teamList');
        TeamView.render(members, $photos, $list);
        $layout.show();
        TeamView.bindInteractions($layout, $photos, $list);
    }
    renderTeam();

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

    // ── POPIA Data Erasure request form — 3 phases in one modal: (1) email -> send code,
    // (2) enter code -> verify + fetch a real per-client booking/refund preview, (3) review that
    // preview + reason/comments/acknowledgement -> submit. The email and code are carried in these
    // two variables between phases (the code is verified-not-consumed in phase 2 so it's still
    // valid when phase 3 re-sends it to actually create the request).
    var popiaVerifiedEmail = '';
    var popiaOtpCode = '';

    function popiaShowPhase(n) {
        $('#popiaPhase1Form').toggle(n === 1);
        $('#popiaPhase2Form').toggle(n === 2);
        $('#popiaPhase3Form').toggle(n === 3);
    }

    function popiaRenderBookingImpact(bookings) {
        var $container = $('#popiaBookingImpact');
        if (!bookings || !bookings.length) { $container.html(''); return; }
        var html = '<div class="tm-form-group" style="background:rgba(212,175,55,0.06); border:1px solid var(--border-low); border-radius:6px; padding:14px 16px;">'
            + '<p style="margin:0 0 10px; font-weight:600; color:var(--text-primary);"><i class="fa-solid fa-triangle-exclamation" style="color:var(--y-base); margin-right:6px;"></i>This will cancel the following booking(s)</p>'
            + '<p style="margin:0 0 12px; font-size:13px; color:var(--text-secondary);">Any refund due will be processed per our Refund Policy, Terms &amp; Conditions and your booking agreement. This may delay completion of your erasure request until that refund is resolved.</p>';
        bookings.forEach(function (b) {
            html += '<div style="border-top:1px solid var(--border-low); padding-top:10px; margin-top:10px; font-size:13px;">'
                + '<div style="display:flex; justify-content:space-between; font-weight:600; color:var(--text-primary);"><span>' + (b.event_name || b.event_type || 'Event') + '</span><span>' + (b.date || '') + '</span></div>'
                + '<div style="color:var(--text-secondary); margin-top:2px;">' + (b.policy_rule || '') + '</div>'
                + '<div style="display:flex; justify-content:space-between; margin-top:4px;"><span>Amount paid: R ' + parseFloat(b.amount_paid || 0).toFixed(2) + '</span><span style="color:var(--y-base); font-weight:600;">Estimated refund: R ' + parseFloat(b.estimated_refund_due || 0).toFixed(2) + '</span></div>'
                + '</div>';
        });
        html += '</div>';
        $container.html(html);
    }

    // Phase 1: email -> send code
    $(document).on('submit', '#popiaPhase1Form', async function (e) {
        e.preventDefault();
        $('#errPopiaEmail').text('');
        var email = $('#popiaEmail').val().trim();
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
            $('#errPopiaEmail').text('Please enter a valid email address.');
            $('#popiaEmail').trigger('focus');
            return;
        }

        var $btn = $('#popiaSendCodeBtn');
        var originalHtml = $btn.html();
        $btn.prop('disabled', true).html('<i class="fa fa-spinner fa-spin"></i>');
        try {
            const res = await fetch('/api/public/popia/request-otp', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email })
            });
            const result = await res.json();
            if (!res.ok || !result.success) throw new Error(result.message || 'Could not send a verification code.');
            popiaVerifiedEmail = email;
            $('#popiaPhase2Email').text(email);
            popiaShowPhase(2);
        } catch (err) {
            window.notificationService.showError(err.message || 'Could not send a verification code. Please try again.');
        } finally {
            $btn.prop('disabled', false).html(originalHtml);
        }
    });

    // Phase 2: verify code (not yet consumed) + fetch the real booking/refund preview
    $(document).on('submit', '#popiaPhase2Form', async function (e) {
        e.preventDefault();
        $('#errPopiaOtpCode').text('');
        var code = $('#popiaOtpCode').val().trim();
        if (!code) {
            $('#errPopiaOtpCode').text('Please enter the verification code.');
            $('#popiaOtpCode').trigger('focus');
            return;
        }

        var $btn = $('#popiaVerifyCodeBtn');
        var originalHtml = $btn.html();
        $btn.prop('disabled', true).html('<i class="fa fa-spinner fa-spin"></i>');
        try {
            const res = await fetch('/api/public/popia/preview', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: popiaVerifiedEmail, otp_code: code })
            });
            const result = await res.json();
            if (!res.ok || !result.success) throw new Error(result.message || 'That code is invalid or has expired.');
            popiaOtpCode = code;
            popiaRenderBookingImpact(result.bookings);
            popiaShowPhase(3);
        } catch (err) {
            $('#errPopiaOtpCode').text(err.message || 'That code is invalid or has expired.');
        } finally {
            $btn.prop('disabled', false).html(originalHtml);
        }
    });

    $(document).on('click', '#popiaResendCodeBtn', async function () {
        var $btn = $(this);
        var originalHtml = $btn.html();
        $btn.prop('disabled', true).text('Sending…');
        try {
            const res = await fetch('/api/public/popia/request-otp', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: popiaVerifiedEmail })
            });
            const result = await res.json();
            if (!res.ok || !result.success) throw new Error(result.message || 'Could not resend the code.');
            window.notificationService.showSuccess('A new code has been sent.');
        } catch (err) {
            window.notificationService.showError(err.message || 'Could not resend the code. Please try again.');
        } finally {
            $btn.prop('disabled', false).html(originalHtml);
        }
    });

    $(document).on('change', '#popiaReason', function () {
        $('#popiaReasonOtherGroup').toggle($(this).val() === 'other');
    });

    // Phase 3: reason/comments/acknowledgement -> actually create the request (this is what
    // consumes the OTP code server-side).
    $(document).on('submit', '#popiaPhase3Form', async function (e) {
        e.preventDefault();
        var $form = $(this);
        $form.find('.tm-field-error').text('');

        var reason = $('#popiaReason').val();
        var reasonOther = $('#popiaReasonOther').val().trim();
        var comments = $('#popiaComments').val().trim();
        var ack = $('#popiaConsequencesAck').is(':checked');

        var firstInvalid = null;
        function invalid($field, errId, message) {
            $('#' + errId).text(message);
            if (!firstInvalid) firstInvalid = $field;
        }
        if (!reason) invalid($('#popiaReason'), 'errPopiaReason', 'Please select a reason for your request.');
        if (reason === 'other' && !reasonOther) invalid($('#popiaReasonOther'), 'errPopiaReasonOther', 'Please describe your reason.');
        if (!ack) invalid($('#popiaConsequencesAck'), 'errPopiaConsequencesAck', 'Please confirm you understand the consequences before submitting.');
        if (firstInvalid) { firstInvalid.trigger('focus'); return; }

        var $btn = $('#popiaErasureSubmitBtn');
        var originalBtnHtml = $btn.html();
        $btn.prop('disabled', true).html('<i class="fa fa-spinner fa-spin"></i>');

        try {
            const res = await fetch('/api/public/popia/erasure-requests', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    email: popiaVerifiedEmail,
                    otp_code: popiaOtpCode,
                    reason: reason,
                    reason_other_text: reason === 'other' ? reasonOther : undefined,
                    additional_comments: comments || undefined,
                    consequences_acknowledged: ack
                })
            });
            const result = await res.json();
            if (!res.ok || !result.success) throw new Error(result.message || 'Submission failed');
            $('#popiaErasureModal').modal('hide');
            window.notificationService.showSuccess(
                (result.message || 'Your data erasure request has been received.') +
                (result.reference_number ? ' Reference: ' + result.reference_number : '')
            );
        } catch (err) {
            console.error('POPIA erasure request error:', err);
            window.notificationService.showError(err.message || 'Could not submit your request. Please try again later.');
        } finally {
            $btn.prop('disabled', false).html(originalBtnHtml);
        }
    });

    $('#popiaErasureModal').on('hidden.bs.modal', function () {
        popiaVerifiedEmail = '';
        popiaOtpCode = '';
        $('#popiaPhase1Form, #popiaPhase2Form, #popiaPhase3Form').each(function () {
            this.reset();
            $(this).find('.tm-field-error').text('');
        });
        $('#popiaReasonOtherGroup').hide();
        $('#popiaBookingImpact').html('');
        popiaShowPhase(1);
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
                const r = await fetch(url, { bypassInterceptor: true });
                if (!r.ok) throw new Error('HTTP ' + r.status);   // rate-limited etc.: use the defaults below, don't cache an error body
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
            // type: 'loading' | 'ok' | 'error' | 'warn' | 'clear' (or false, for a server-side validation message)
            // The date field's feedback is drawn by the selected-date bar under the calendar (#bookDateDisplay,
            // renderSelectedDate() in the calendar script at the bottom of this file). This only supplies the MESSAGE:
            // the bar's colour and icon come from the selected date's availability state - the very state that colours
            // its calendar cell - never from `type`, so a message can't contradict the date it describes.
            $('#bookDate').removeClass('bk-input--err bk-input--ok');
            $('#err-bookDate').hide();
            if (window.bkSetDateMessage) window.bkSetDateMessage(type === 'clear' ? '' : type === 'loading' ? 'loading' : 'text', html);
        }

        // "18:00–20:00" (first three windows) for the reserved-date message
        function bkBusyText(ranges) {
            return ranges.slice(0, 3).map(function (r) { return r.start + '–' + r.end; }).join(', ') + (ranges.length > 3 ? ' and more' : '');
        }

        $('#bookDate').on('change', async function() {
            const date = $(this).val();
            dateAvailable = false;
            currentBusyRanges = [];
            $('#bookNext1').prop('disabled', true);

            if (!date) { setDateStatus('clear'); renderTimeSlots(); return; }

            setDateStatus('loading', 'Checking availability…');

            // Whatever the server says about THIS date is handed to the calendar (bkNoteDateVerdict) so the date's cell
            // and the selected-date bar are redrawn from one state - and it is only APPLIED here while the visitor is
            // still on this date: a slow answer for an earlier pick must not overwrite a later one.
            const stillCurrent = () => $('#bookDate').val() === date;
            let data;
            try {
                const r = await fetch('/api/public/availability?date=' + encodeURIComponent(date), { bypassInterceptor: true });
                // A rate-limited (429) or failing (5xx) answer says nothing about the DATE — it must not be
                // reported as "this date is not available". Treat it like a network error (below).
                if (r.status === 429 || r.status >= 500) throw new Error('availability check unavailable (' + r.status + ')');
                data = await r.json();
            } catch(e) {
                // Couldn't reach / trust the availability check: allow continuation (the server re-checks the
                // date when the booking is submitted) — but SAY so, instead of silently clearing the status.
                if (window.bkNoteDateVerdict) window.bkNoteDateVerdict(date, 'unknown');
                if (!stillCurrent()) return;
                dateAvailable = true;
                $('#bookNext1').prop('disabled', false);
                setDateStatus('warn', 'We couldn\'t confirm this date\'s availability just now. You can continue — we\'ll confirm it with you.');
                renderTimeSlots();
                return;
            }

            const busy = data.available ? (data.busy_ranges || []) : [];
            if (window.bkNoteDateVerdict) {
                window.bkNoteDateVerdict(date, data.available ? (busy.length ? 'partial' : 'avail')
                    : data.reason === 'held' ? 'held' : data.reason === 'too_soon' ? 'soon' : 'full');
            }
            if (!stillCurrent()) return;

            if (data.available) {
                dateAvailable = true;
                currentBusyRanges = busy;
                $('#bookNext1').prop('disabled', false);
                setDateStatus('ok', busy.length
                    ? 'Reserved: ' + bkBusyText(busy) + (busy.length === 1 ? ' is' : ' are') + ' taken, but the rest of the day is open.'
                    : (data.message || 'This date is available!'));
            } else {
                dateAvailable = false;
                let msg = data.message || 'This date is not available.';
                if (data.suggestion && data.suggestion_label) {
                    msg += ` <a href="#" id="bk-use-suggestion" class="bk-date-status__link" data-date="${data.suggestion}">Try ${data.suggestion_label} instead →</a>`;
                }
                setDateStatus(data.reason === 'too_soon' ? 'warn' : 'error', msg);
            }
            renderTimeSlots();
        });

        // Handle "use suggestion" click
        $(document).on('click', '#bk-use-suggestion', function(e) {
            e.preventDefault();
            const suggested = $(this).data('date');
            // Through the calendar, so it flips to that month and marks the date like any other pick.
            if (window.bkPickDate) window.bkPickDate(suggested);
            else $('#bookDate').val(suggested).trigger('change');
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

        // ── Performance slot picker ─────────────────────────────────────────────────────────────
        // Availability logic is unchanged: a start time is unavailable if its window (start + the chosen
        // duration) overlaps a busy range (existing booking / hold / event on that date) or would run past
        // working hours. What changed is how it is presented and operated:
        //  - start times are grouped Morning / Afternoon / Evening so a long day is easy to scan;
        //  - each chip shows the START and END time for the chosen duration ("09:00 to 10:00");
        //  - every chip is a real <button> (keyboard + screen-reader operable) with arrow-key movement;
        //  - unavailable chips say WHY (Blocked / After hours) instead of only being struck through;
        //  - loading / "pick a date first" / "not available" states are explicit;
        //  - the current selection survives a re-render (date or duration change) — or is cleared with
        //    an explanation if it no longer fits — so the grid and the hidden slot fields never disagree.
        var BK_SLOT_GROUPS = [
            { key: 'morning',   label: 'Morning',   from: 0,    to: 720 },
            { key: 'afternoon', label: 'Afternoon', from: 720,  to: 1020 },
            { key: 'evening',   label: 'Evening',   from: 1020, to: 1440 }
        ];
        var _bkSlotRenderSeq = 0; // a newer render supersedes one still waiting on the booking config

        function bkSlotMsg(html, cls) { return '<div class="bk-slot-msg' + (cls ? ' ' + cls : '') + '" role="status">' + html + '</div>'; }
        function bkPad2(n) { return String(n).padStart(2, '0'); }
        function bkClockStr(totalMins) { return bkPad2(Math.floor(totalMins / 60) % 24) + ':' + bkPad2(totalMins % 60); }
        function bkSlotEndFor(time, durMins) {
            var p = time.split(':').map(Number);
            var endMins = p[0] * 60 + p[1] + durMins;
            var h = Math.floor(endMins / 60), m = endMins % 60;
            if (h >= 24) { h = 23; m = 59; } // same clamp the picker has always applied to the stored end time
            return bkPad2(h) + ':' + bkPad2(m);
        }
        // The readout above the grid shows this until a slot is chosen.
        function bkSlotHint() {
            $('#bkReadoutText').html('<span style="color:#888;font-size:var(--fs-sm);font-style:italic;">Select a time slot below</span>');
            $('#bkSmartReadout').css('display', 'flex');
        }

        async function renderTimeSlots() {
            const $grid = $('#bkTimeSlotsGrid');
            if (!$grid.length) return;
            const seq = ++_bkSlotRenderSeq;

            $grid.empty().removeAttr('aria-busy');

            const selectedDate = $('#bookDate').val();
            if (!selectedDate) {
                $grid.append(bkSlotMsg('Choose an event date in Step 1 to see the available times.'));
                return;
            }
            if (!dateAvailable) {
                $grid.append(bkSlotMsg('This date is not available. Please go back and choose another date.', 'bk-slot-msg--warn'));
                return;
            }

            $grid.attr('aria-busy', 'true').append(bkSlotMsg('<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> Loading available times…'));

            // Fetch per-day working hours using the selected date's day-of-week
            const dow = new Date(selectedDate + 'T00:00:00').getDay(); // 0=Sun … 6=Sat
            const cfg = await getBkConfig(dow);
            if (seq !== _bkSlotRenderSeq) return; // the date/duration changed while this loaded
            $grid.empty().removeAttr('aria-busy');

            if (cfg.is_working_day === false) {
                $grid.append(bkSlotMsg('Not a working day — contact us for special arrangements.', 'bk-slot-msg--warn'));
                return;
            }

            const [startH, startM] = cfg.working_hours_start.split(':').map(Number);
            const [endH, endM]     = cfg.working_hours_end.split(':').map(Number);
            const endTotalMins     = endH === 0 && endM === 0 ? 1440 : (endH * 60 + (endM || 0));
            const slots = [];
            const loopEndH         = endH === 0 && endM === 0 ? 24 : endH;

            for (let h = startH; h < loopEndH; h++) {
                if (h === startH && startM >= 30) {
                    slots.push(`${bkPad2(h)}:30`);
                } else {
                    slots.push(`${bkPad2(h)}:00`);
                    slots.push(`${bkPad2(h)}:30`);
                }
            }

            // Selected duration in minutes (from duration selector)
            const durMins = parseInt($('#bkReadoutDurSelect').val()) || 60;

            if (durMins >= 1440) {
                $grid.append(
                    '<button type="button" class="bk-time-slot bk-time-slot--allday" data-time="All Day" aria-pressed="false">' +
                    '<i class="fa-solid fa-sun" aria-hidden="true"></i> Confirm Full Day / Custom Hours</button>'
                );
                if ($('#bkSlotFrom').val() === 'All Day') $grid.find('.bk-time-slot').addClass('selected').attr('aria-pressed', 'true');
                return;
            }

            const currentFrom = $('#bkSlotFrom').val();
            let selectedStillValid = false;
            const groups = BK_SLOT_GROUPS.map(g => Object.assign({ chips: [], free: 0 }, g));

            slots.forEach(time => {
                const [slotH, slotM] = time.split(':').map(Number);
                const slotStartMins = slotH * 60 + slotM;
                const slotEndMins = slotStartMins + durMins;
                const slotEndStr = bkClockStr(slotEndMins);

                // Check if already busy (existing booking / hold)
                let reason = '';
                if (currentBusyRanges && currentBusyRanges.length > 0) {
                    currentBusyRanges.forEach(r => {
                        // Check if the slot range overlaps with the busy range [r.start, r.end]
                        if ((time < r.end) && (r.start < slotEndStr)) reason = 'blocked';
                    });
                }
                // Also unavailable if slot + duration would exceed working hours end
                if (!reason && slotEndMins > endTotalMins) reason = 'hours';

                const $chip = $('<button type="button" class="bk-time-slot"></button>').attr({ 'data-time': time, 'data-end': slotEndStr })
                    .append($('<span class="bk-time-slot__start"></span>').text(time));
                if (reason) {
                    const why = reason === 'blocked' ? 'Blocked' : 'After hours';
                    $chip.addClass('busy').prop('disabled', true).attr({
                        'aria-label': time + ' — unavailable (' + (reason === 'blocked' ? 'already booked or blocked' : 'exceeds working hours for ' + durMins + ' minutes') + ')',
                        title: reason === 'blocked' ? 'Already booked or blocked' : `Requires ${durMins} min — exceeds working hours`
                    }).append($('<span class="bk-time-slot__end"></span>').text(why));
                } else {
                    $chip.attr({ 'aria-pressed': 'false', 'aria-label': time + ' to ' + slotEndStr })
                        .append($('<span class="bk-time-slot__end"></span>').text('to ' + slotEndStr));
                    if (currentFrom === time) { $chip.addClass('selected').attr('aria-pressed', 'true'); selectedStillValid = true; }
                }
                const grp = groups.find(g => slotStartMins >= g.from && slotStartMins < g.to) || groups[groups.length - 1];
                grp.chips.push($chip);
                if (!reason) grp.free++;
            });

            groups.filter(g => g.chips.length).forEach(g => {
                const headId = 'bkSlotGrp-' + g.key;
                const $grp = $('<div class="bk-slot-group" role="group"></div>').attr('aria-labelledby', headId);
                $grp.append(
                    $('<div class="bk-slot-group__head"></div>').attr('id', headId)
                        .append($('<span class="bk-slot-group__title"></span>').text(g.label))
                        .append($('<span class="bk-slot-group__count"></span>').text(g.free + ' of ' + g.chips.length + ' available'))
                );
                const $row = $('<div class="bk-slot-group__grid"></div>');
                g.chips.forEach($c => $row.append($c));
                $grp.append($row);
                $grid.append($grp);
            });

            $grid.append(
                '<div class="bk-slot-legend" aria-hidden="true">' +
                '<span><i class="bk-slot-dot bk-slot-dot--free"></i>Available</span>' +
                '<span><i class="bk-slot-dot bk-slot-dot--sel"></i>Selected</span>' +
                '<span><i class="bk-slot-dot bk-slot-dot--busy"></i>Unavailable</span></div>'
            );

            // Roving tabindex: one Tab stop for the whole picker (the selected chip, else the first free one);
            // arrow keys move within it (see the keydown handler below).
            const $free = $grid.find('.bk-time-slot:not(.busy)');
            $free.attr('tabindex', '-1');
            ($free.filter('.selected').first().length ? $free.filter('.selected').first() : $free.first()).attr('tabindex', '0');

            // The earlier selection no longer fits (date or duration changed) — clear it and say so, so the
            // grid and the hidden slot fields never disagree.
            if (currentFrom && currentFrom !== 'All Day' && currentFrom !== 'Custom' && !selectedStillValid) {
                $('#bkSlotFrom').val('');
                $('#bkSlotTo').val('');
                $('#bookSlot').val('');
                bkSlotHint();
                $grid.prepend(bkSlotMsg('Your earlier start time (' + currentFrom + ') doesn\'t fit this date or duration — please choose another.', 'bk-slot-msg--warn'));
            }
        }

        // Choose a start time (delegated: chips are rebuilt on every render).
        $(document).on('click', '#bkTimeSlotsGrid .bk-time-slot:not(.busy)', function() {
            const time = $(this).attr('data-time');
            $('#bkTimeSlotsGrid .bk-time-slot').removeClass('selected').attr('aria-pressed', 'false').attr('tabindex', '-1');
            $(this).addClass('selected').attr({ 'aria-pressed': 'true', tabindex: '0' });
            $('#err-bookSlot').hide();
            $('#bkTimeSlotsGrid').removeClass('bk-input--err').removeAttr('aria-invalid').removeAttr('aria-describedby');

            if (time === 'All Day') {
                $('#bkSlotFrom').val('All Day').trigger('change');
                $('#bkSlotTo').val('All Day').trigger('change');
                return;
            }
            const durMins = parseInt($('#bkReadoutDurSelect').val()) || 60;
            $('#bkSlotFrom').val(time).trigger('change');
            $('#bkSlotTo').val(bkSlotEndFor(time, durMins)).trigger('change');
        });

        // Arrow keys move between free start times (Left/Right = previous/next, Up/Down = same column in the
        // adjacent row, Home/End = first/last); Enter/Space activate natively because the chips are buttons.
        $(document).on('keydown', '#bkTimeSlotsGrid .bk-time-slot', function(e) {
            const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
            if (keys.indexOf(e.key) < 0) return;
            const $all = $('#bkTimeSlotsGrid .bk-time-slot:not(.busy)');
            const i = $all.index(this);
            let n = i;
            if (e.key === 'ArrowLeft') n = i - 1;
            else if (e.key === 'ArrowRight') n = i + 1;
            else if (e.key === 'Home') n = 0;
            else if (e.key === 'End') n = $all.length - 1;
            else {
                // Up/Down: pick the nearest free chip in the row above/below at (about) the same x position.
                const r = this.getBoundingClientRect(), dir = e.key === 'ArrowDown' ? 1 : -1;
                let best = null, bestScore = Infinity;
                $all.each(function(j) {
                    if (j === i) return;
                    const b = this.getBoundingClientRect();
                    const dy = (b.top - r.top) * dir;
                    if (dy < 4) return;                       // not in a row below/above
                    const score = dy * 1000 + Math.abs(b.left - r.left);
                    if (score < bestScore) { bestScore = score; best = j; }
                });
                if (best !== null) n = best;
            }
            e.preventDefault();
            if (n < 0 || n >= $all.length || n === i) return;
            $all.attr('tabindex', '-1');
            $all.eq(n).attr('tabindex', '0').trigger('focus');
        });

        // Patch Next button on step 1 to also gate on date availability
        const _origNext1 = $('#bookNext1').off('click').click;
        $('#bookNext1').on('click', function() {
            if (!dateAvailable) {
                // A date is chosen but isn't (yet) bookable: make sure the reason is on screen (the selected-date
                // bar normally already says why).
                if ($('#bookDate').val() && !$.trim($('#hint-bookDate').text())) setDateStatus('warn', 'Please select an available date before continuing.');
                // validateStep(1) reports everything wrong on this step — the missing date (warning +
                // aria-invalid) and any missing event name / type / service — instead of the click
                // silently doing nothing on a fresh form.
                validateStep(1);
                return;
            }
            
            if (validateStep(1)) updateProgress(2);
        });

        // --- VENUE AUTOCOMPLETE (server-side proxy, no client-side Maps JS dependency) ---
        var _venueDebounce = null;
        var _venueInited = false;

        // Venue search runs through the server's Places proxy (/api/public/places/*), unchanged. What this adds:
        //  - combobox semantics (role=combobox/listbox/option, aria-expanded, aria-activedescendant);
        //  - stale responses are discarded and in-flight searches aborted, so results never lag the text;
        //  - a per-session cache: repeat searches don't spend the per-IP request budget that the availability
        //    calendar (and everything else on the page) shares — searching now starts at 3 characters, 350ms debounce;
        //  - loading / no-results / unavailable messages instead of a silent dropdown;
        //  - editing the venue name after picking a place clears the place id AND the address fields that place
        //    filled in (never anything the visitor typed themselves), so a stale address can't ride along;
        //  - the chosen address is confirmed on screen, not hidden behind "Edit address details manually".
        var _venueCache = {};      // lower-cased query -> predictions
        var _venueReqSeq = 0;      // bumped on every keystroke; a response for an older seq is ignored
        var _venueXhr = null;

        function venueStatus(html, kind) {
            var $s = $('#venueStatus');
            if (!html) { $s.hide().empty(); return; }
            $s.attr('class', 'bk-venue-status' + (kind ? ' bk-venue-status--' + kind : '')).html(html).show();
        }
        function venueClose() {
            $('#venueDropdown').empty().hide();
            $('#bookLocation').attr('aria-expanded', 'false').removeAttr('aria-activedescendant');
        }
        // Fields a place selection fills in are flagged, so a later change of venue clears exactly those.
        function venueSetAuto(sel, val) { $(sel).val(val).data('bkAuto', true); }
        function venueClearAuto() {
            ['#bookAddress', '#bookCity', '#bookCountry'].forEach(function(s) {
                var $e = $(s);
                if ($e.data('bkAuto')) $e.val('').data('bkAuto', false);
            });
            $('#venuePlaceId, #venueState, #venuePostalCode, #venueLatitude, #venueLongitude').val('');
            $('#venueSelected').hide().empty();
        }
        // Confirms the address that came from the selected place (also used when a draft is restored).
        function bkRenderVenueSelected() {
            var $box = $('#venueSelected');
            var addr = ($('#bookAddress').val() || '').trim();
            if (!$('#venuePlaceId').val() || !addr) { $box.hide().empty(); return; }
            $box.html('<i class="fa-solid fa-circle-check" aria-hidden="true"></i><span>' + bkEsc(addr) + '</span>').show();
        }
        $(document).on('input', '#bookAddress, #bookCity, #bookCountry', function() { $(this).data('bkAuto', false); });

        function venueSetActive($items, idx) {
            $items.removeClass('vdd-active').attr('aria-selected', 'false');
            var $a = $items.eq(idx).addClass('vdd-active').attr('aria-selected', 'true');
            $('#bookLocation').attr('aria-activedescendant', $a.attr('id'));
            if ($a[0] && $a[0].scrollIntoView) $a[0].scrollIntoView({ block: 'nearest' });
        }

        function venueRenderPredictions(predictions) {
            var $dd = $('#venueDropdown').empty();
            if (!predictions.length) {
                // No matches (or the Places API itself is unavailable) — don't leave the visitor stuck with a
                // dead search box; offer manual entry instead.
                $dd.hide();
                $('#bookLocation').attr('aria-expanded', 'false');
                venueStatus('No matching venues found — you can enter the address manually.', 'muted');
                $('.manual-address-toggle-wrap').show();
                return;
            }
            venueStatus('');
            predictions.slice(0, 6).forEach(function(p, i) {
                var main = p.main_text || p.description || '';
                var sec  = p.secondary_text || '';
                $('<div class="vdd-item" role="option" tabindex="-1" aria-selected="false">').attr('id', 'venueOpt-' + i).html(
                    '<span class="vdd-main">' + bkEsc(main) + '</span>' +
                    (sec ? '<span class="vdd-sec">' + bkEsc(sec) + '</span>' : '')
                ).on('mousedown', function(e) {
                    e.preventDefault();
                    venueChoose(p, main);
                }).appendTo($dd);
            });
            $dd.show();
            $('#bookLocation').attr('aria-expanded', 'true');
            // Keep the list clear of the sticky footer on small screens (see scroll-margin in booking-form.css).
            if ($dd[0] && $dd[0].scrollIntoView) $dd[0].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }

        function venueChoose(p, main) {
            var $input = $('#bookLocation');
            venueClose();
            venueStatus('<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> Getting the address…');
            $.ajax({
                url: '/api/public/places/details',
                bypassInterceptor: true,   // failures are shown inline (venueStatus), not as an extra toast
                data: { place_id: p.place_id },
                success: function(detailData) {
                    venueStatus('');
                    if (!detailData || !detailData.result) {
                        $input.val(main);
                        venueStatus('We couldn\'t fetch the full address — please check the details below.', 'warn');
                        $('.manual-address-toggle-wrap').show();
                        return;
                    }
                    var place = detailData.result;
                    $input.val(place.name || main);
                    $('#venuePlaceId').val(p.place_id || '');
                    venueSetAuto('#bookAddress', place.formatted_address || '');
                    // Shared parser (js/shared/location-utils.js) — the same one the admin portal's
                    // Places Autocomplete uses (js/admin/places-autocomplete.js); Google's
                    // address_components array has the identical shape from both the REST API
                    // (here) and the Maps JS SDK (there). cityOrState() is this field's own existing,
                    // tested display rule (a true city, else the province) — kept local to it rather
                    // than folded into the shared parser, which never blurs city and state together.
                    var addr = window.TMLocation ? window.TMLocation.parseAddressComponents(place.address_components) : { city: '', state: '', postalCode: '', country: '' };
                    var cityForDisplay = window.TMLocation ? window.TMLocation.cityOrState(addr) : (addr.city || addr.state);
                    if (cityForDisplay) venueSetAuto('#bookCity', cityForDisplay);
                    if (addr.country) venueSetAuto('#bookCountry', addr.country);
                    // Additive: state/postal code/coordinates aren't shown anywhere, just carried
                    // through to enrich the venues row on submit (2026-09-29 consolidation) — Google
                    // already returns them in this same response; they used to be discarded here.
                    $('#venueState').val(addr.state || '');
                    $('#venuePostalCode').val(addr.postalCode || '');
                    var loc = place.geometry && place.geometry.location; // REST API shape: plain {lat, lng} numbers, not the JS SDK's LatLng methods
                    $('#venueLatitude').val(loc && typeof loc.lat === 'number' ? loc.lat : '');
                    $('#venueLongitude').val(loc && typeof loc.lng === 'number' ? loc.lng : '');
                    $input.removeClass('bk-input--err');
                    $('#err-bookLocation').hide();
                    bkRenderVenueSelected();
                    $('.manual-address-toggle-wrap').show();
                },
                error: function() {
                    $input.val(main);
                    venueStatus('We couldn\'t fetch the full address — please check the details below.', 'warn');
                    $('.manual-address-toggle-wrap').show();
                }
            });
        }

        function initAutocomplete() {
            if (_venueInited) return;
            _venueInited = true;

            var $input = $('#bookLocation');
            var $dd    = $('#venueDropdown');

            $input.off('input.venueAC').on('input.venueAC', function() {
                var q = $(this).val().trim();
                clearTimeout(_venueDebounce);
                if (_venueXhr) { _venueXhr.abort(); _venueXhr = null; }
                var seq = ++_venueReqSeq;
                venueClose();
                // Typing changes which venue this is: the previously selected place (and the address it filled in)
                // no longer describes it.
                if ($('#venuePlaceId').val()) venueClearAuto();
                $('.manual-address-toggle-wrap').hide();
                if (q.length < 3) { venueStatus(q.length ? 'Keep typing to search for venues…' : '', 'muted'); return; }

                var cached = _venueCache[q.toLowerCase()];
                if (cached) { venueRenderPredictions(cached); return; }

                venueStatus('<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> Searching venues…');
                _venueDebounce = setTimeout(function() {
                    _venueXhr = $.ajax({
                        url: '/api/public/places/autocomplete',
                        bypassInterceptor: true,   // failures are shown inline (venueStatus), not as an extra toast
                        data: { input: q },
                        success: function(data) {
                            if (seq !== _venueReqSeq) return;          // the text has moved on
                            var predictions = (data && data.predictions) || [];
                            _venueCache[q.toLowerCase()] = predictions;
                            venueRenderPredictions(predictions);
                        },
                        error: function(xhr, status) {
                            if (status === 'abort' || seq !== _venueReqSeq) return;
                            venueClose();
                            venueStatus(xhr && xhr.status === 429
                                ? 'Too many searches just now — please enter the address manually or try again shortly.'
                                : 'Venue search isn\'t available right now — you can enter the address manually.', 'warn');
                            $('.manual-address-toggle-wrap').show();
                        }
                    });
                }, 350);
            });

            $input.off('keydown.venueAC').on('keydown.venueAC', function(e) {
                var open = $dd.is(':visible');
                var $items = $dd.find('.vdd-item');
                var cur = $items.index($items.filter('.vdd-active'));
                if (e.key === 'Escape') { if (open) { e.preventDefault(); e.stopPropagation(); venueClose(); } return; }
                if (e.key === 'ArrowDown' && open) { e.preventDefault(); venueSetActive($items, cur < 0 ? 0 : Math.min(cur + 1, $items.length - 1)); }
                else if (e.key === 'ArrowUp' && open) { e.preventDefault(); venueSetActive($items, cur <= 0 ? $items.length - 1 : cur - 1); }
                else if (e.key === 'Enter') {
                    // Enter must never submit the wizard from here; with the list open it picks the highlighted (else first) venue.
                    e.preventDefault();
                    if (open) ($items.filter('.vdd-active').length ? $items.filter('.vdd-active') : $items.first()).trigger('mousedown');
                }
            });
            $input.off('blur.venueAC').on('blur.venueAC', function() { setTimeout(venueClose, 150); });

            $(document).off('click.venueAC').on('click.venueAC', function(ev) {
                if (!$(ev.target).closest('#bookLocation, #venueDropdown').length) venueClose();
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

        // "How did you hear about us?" is a dropdown; "Other" reveals a text box. The value stored/submitted
        // stays the same plain text the backend and admin already handle (free text, <=200 chars), so no
        // schema or admin change is needed.
        function bkHeardAboutValue() {
            var sel = $('#bookHeardAbout').val() || '';
            if (sel !== 'Other') return sel;
            var other = ($('#bookHeardAboutOther').val() || '').trim();
            return other ? 'Other: ' + other : 'Other';
        }
        function bkSyncHeardAbout() {
            var isOther = $('#bookHeardAbout').val() === 'Other';
            $('#bookHeardAboutOtherWrap').toggle(isOther);
            if (!isOther) $('#bookHeardAboutOther').val('');
        }
        $(document).on('change', '#bookHeardAbout', function() {
            bkSyncHeardAbout();
            if ($(this).val() === 'Other') $('#bookHeardAboutOther').trigger('focus');
        });
        $('#dedicatedBookingForm').on('reset', function() { setTimeout(bkSyncHeardAbout, 0); });

        var _bkDraftFields = ['bookEventName','bookType','bookDate','bookName','bookEmail','bookCell',
            'bookCompany','bookLocation','bookAddress','bookCity',
            'bookCountry','bookAudience','bookDemographic','bookTravel','bookNotes',
            'bookBudget','bookAltDates','bookContentNotes','bookHeardAbout','bookHeardAboutOther',
            // Venue type, the selected Places id and the chosen slot/duration used to be dropped on close/reopen.
            'bookVenueType','venuePlaceId','bkSlotFrom','bkSlotTo','bkReadoutDurSelect',
            // Additive richer venue fields (2026-09-29 consolidation) — carried the same way venuePlaceId already was.
            'venueState','venuePostalCode','venueLatitude','venueLongitude'];

        // True once the visitor has entered something worth keeping. bookCountry / bookTravel are
        // deliberately ignored: they can hold a default value on an untouched form.
        // Contact details that bkPrefillClientInfo() filled in and the visitor hasn't changed don't
        // count either — they didn't type them.
        function bkHasDraftProgress() {
            if ($('#bkServicesTableBody tr').length) return true;
            var prefill = null;
            if ($('#bkPrefillNote').length) {
                try { prefill = JSON.parse(localStorage.getItem('bkClientInfo') || 'null'); } catch (e) {}
            }
            var prefillKey = { bookName: 'name', bookEmail: 'email', bookCell: 'cell', bookCompany: 'company' };
            return _bkDraftFields.some(function(id) {
                if (id === 'bookCountry' || id === 'bookTravel' || id === 'bkReadoutDurSelect') return false;   // defaults on an untouched form
                var v = String($('#' + id).val() || '').trim();
                if (v === '') return false;
                return !(prefill && prefillKey[id] && String(prefill[prefillKey[id]] || '').trim() === v);
            });
        }
        // Set while the close-time reset runs, so resetting the form can't save a blank draft over
        // the real one (the reset calls updateProgress(1), which saves).
        var _bkDraftSuppressed = false;

        function saveBkDraft(localOnly) {
            if (_bkDraftSuppressed || !bkHasDraftProgress()) return;
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
                if (localOnly) return;   // close-time save: flushBkDraft's beacon already covers the server copy
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
        // localStorage draft in the existing format, then let the atl:drawerOpened
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
                        if (window.openAtlDrawer) openAtlDrawer('bookingDrawer');
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
                // First VISIBLE error: on step 1 the first .bk-input--err in DOM order is the hidden
                // #bookDate input, which can be neither scrolled to nor focused.
                var $firstErr = $('#bookStep' + step).find('.bk-input--err:visible').first();
                if ($firstErr.length) {
                    $firstErr[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
                    // Non-input targets (time-slot grid, date display) need a tabindex to take focus.
                    if (!$firstErr.is(':input, [tabindex]')) {
                        $firstErr.attr('tabindex', '-1');
                    }
                    $firstErr.focus();
                }
            }

            return ok;
        }

        // Escapes text for insertion via .html() — everything here is either typed by the visitor or
        // comes from the service catalogue, so none of it should be interpreted as markup.
        function bkEsc(s) { return $('<div>').text(String(s == null ? '' : s)).html(); }

        function buildReview() {
            var srvHtml = '';
            $('#bkServicesTableBody tr').each(function() {
                // The first cell holds the service name plus separate elements for its unit, duration,
                // travel badge and notice/limit hints. Reading the whole cell's .text() ran them all
                // together ("Full Dayunit~480 min performance...notice1 booking per day limit").
                var $info = $(this).find('td:first > div > div').first().children();
                var name = $info.first().text().trim() || $(this).find('td:first').text().trim();
                var detailsHtml = $info.slice(1).map(function() {
                    var t = $(this).text().trim();
                    if (!t || t.toLowerCase() === 'unit') return '';   // "unit" is just the catalogue's placeholder label
                    return '<div style="font-size:10px;color:#888;font-weight:400;margin-top:1px;">' + bkEsc(t) + '</div>';
                }).get().join('');
                var qty = parseInt($(this).find('.bk-svc-qty').val()) || 0;
                var model = $(this).data('model');
                var qtyDisp = model === 'per_minute' ? formatDuration(qty) : qty;
                srvHtml += '<div style="margin-bottom:5px;font-size:12px;"><strong>' + bkEsc(name) + '</strong> (' + bkEsc(qtyDisp) + ')' + detailsHtml + '</div>';
            });
            // P8: Include Venue Name and Company so the user can verify the
            // two most critical identifiers on the Review screen before submitting.
            var rows = [
                ['Event Name',            $('#bookEventName').val()],
                ['Event Type',            $('#bookType').val()],
                ['Services Required',     srvHtml || '\u2014', true],   // true = already-escaped HTML
                ['Event Date',            window.bkLongDate ? window.bkLongDate($('#bookDate').val()) : $('#bookDate').val()],
                ['Performance Slot',      $('#bookSlot').val() || '\u2014'],
                ['Venue / Location',      $('#bookLocation').val() || '\u2014'],
                ['Venue Type',            $('#bookVenueType').val() || '\u2014'],
                ['Notes / Requirements',  $('#bookNotes').val() || '\u2014'],
                ['Audience Size',         $('#bookAudience').val() || '\u2014'],
                ['Audience Demographic',  $('#bookDemographic').val() || '\u2014'],
                ['Budget Range',          $('#bookBudget').val() || '\u2014'],
                ['Alternative Dates',     $('#bookAltDates').val() || '\u2014'],
                ['Content Suitability',   $('#bookContentNotes').val() || '\u2014'],
                ['How You Heard About Us', bkHeardAboutValue() || '\u2014'],
                ['Full Name',             $('#bookName').val()],
                ['Company / Organization', $('#bookCompany').val() || '\u2014'],
                ['Email',                 $('#bookEmail').val()],
                ['Phone',                 $('#bookCell').val()],
                ['City / Country',        [$('#bookCity').val(), $('#bookCountry').val()].filter(Boolean).join(', ') || '\u2014'],
                ['Travel & Accommodation', $('#bookTravel').val() || '\u2014']
            ];
            var html = rows.map(function(r) {
                var val = r[1] || '\u2014';
                return '<div class="book-review-row"><span>' + r[0] + '</span><span>' + (r[2] ? val : bkEsc(val)) + '</span></div>';
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
                    if (window.closeAtlDrawer) closeAtlDrawer('bookingDrawer');
                    setTimeout(function() {
                        $('#trackId').val(clash.id);
                        $('#trackEmail').val(email);
                        if (window.openAtlDrawer) openAtlDrawer('trackingDrawer');
                    }, 400);
                });
                return;
            }

            updateProgress(3);
            setTimeout(renderTimeSlots, 400);
        });
        $('#bookNext3').on('click', function() { if (validateStep(3)) { buildReview(); updateProgress(4); } });

        // Enter in a single-line field means "Next" on steps 1-3. The form's only submit button is on the
        // review step, so Enter used to fire a hidden submit that wrote an error into an element nobody could
        // see and left the wizard where it was. (The venue field has its own Enter handling: it picks the
        // highlighted suggestion.)
        $('#dedicatedBookingForm').on('keydown', 'input:not([type=checkbox]):not([type=file]):not([type=hidden]):not(#bookLocation)', function(e) {
            if (e.key !== 'Enter' || e.isComposing || e.originalEvent && e.originalEvent.isComposing) return;
            if (currentStep >= 1 && currentStep <= 3) {
                e.preventDefault();
                $('#bookNext' + currentStep).trigger('click');
            }
        });
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
                            if (window.closeAtlDrawer) closeAtlDrawer('bookingDrawer');
                            setTimeout(function() {
                                $('#trackId').val(clash.id);
                                $('#trackEmail').val(v);
                                if (window.openAtlDrawer) openAtlDrawer('trackingDrawer');
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
                // Additive richer venue fields (2026-09-29 consolidation) — enrich the venues row; never shown, never required.
                venue_state: $('#venueState').val().trim(),
                venue_postal_code: $('#venuePostalCode').val().trim(),
                venue_latitude: $('#venueLatitude').val().trim(),
                venue_longitude: $('#venueLongitude').val().trim(),
                city: $('#bookCity').val().trim(),
                country: $('#bookCountry').val().trim(),
                venue_type: $('#bookVenueType').val(),
                event_type: $('#bookType').val(),
                audience_size: $('#bookAudience').val().trim(),
                audience_demographic: $('#bookDemographic').val().trim(),
                budget_range: $('#bookBudget').val() || null,
                alternative_dates: $('#bookAltDates').val().trim(),
                content_notes: $('#bookContentNotes').val().trim(),
                heard_about: bkHeardAboutValue(),
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
                        if (window.closeAtlDrawer) closeAtlDrawer('bookingDrawer');
                        setTimeout(function() {
                            $('#trackId').val(result.booking_id);
                            $('#trackEmail').val(submitData.email);
                            if (window.openAtlDrawer) openAtlDrawer('trackingDrawer');
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
                        if (window.closeAtlDrawer) closeAtlDrawer('bookingDrawer');
                        setTimeout(function() {
                            $('#trackId').val(existingId);
                            $('#trackEmail').val($('#bookEmail').val().trim());
                            if (window.openAtlDrawer) openAtlDrawer('trackingDrawer');
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
                } else if (msg.includes('alternative dates')) {
                    // Checked ahead of the generic 'characters' branch below — that one would
                    // otherwise catch this message too (it also contains the word "characters")
                    // and incorrectly highlight bookNotes instead of this field.
                    setFieldState('bookAltDates', false, msg);
                    mapped = true;
                } else if (msg.includes('content notes')) {
                    setFieldState('bookContentNotes', false, msg);
                    mapped = true;
                } else if (msg.includes('heard about')) {
                    setFieldState('bookHeardAbout', false, msg);
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

        // Track which entry point opened the booking drawer (Gap 12: source attribution)
        window._bkSource = 'direct';
        $('[data-open-drawer="bookingDrawer"]').on('click', function() {
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

        // Refresh calendar each time the drawer opens; restore any in-progress draft.
        // atl:drawerOpened fires synchronously from openAtlDrawer(), right as the slide-in
        // starts — same timing 'show.bs.modal' gave this handler.
        document.addEventListener('atl:drawerOpened', function(e) {
            if (!e.detail || e.detail.id !== 'bookingDrawer') return;
            if (window.refreshAvailCalendar) window.refreshAvailCalendar();
            try {
                var raw = localStorage.getItem('bkDraft');
                if (raw) {
                    var draft = JSON.parse(raw);
                    if (draft && draft.fields) {
                        Object.keys(draft.fields).forEach(function(id) {
                            var val = draft.fields[id];
                            if (val) {
                                $('#' + id).val(val);
                                // A draft saved before this became a dropdown holds free text: keep it under "Other".
                                if (id === 'bookHeardAbout' && $('#bookHeardAbout').val() !== val) {
                                    $('#bookHeardAbout').val('Other');
                                    $('#bookHeardAboutOther').val(String(val).replace(/^Other:\s*/i, ''));
                                }
                            }
                        });

                        // Trigger change to update UI for Virtual Event or other dynamically controlled fields
                        $('#bookType').trigger('change');
                        bkSyncHeardAbout();
                        bkRenderVenueSelected();
                        // Rebuild the readout / hidden slot field from the restored start + end (the grid re-selects
                        // the matching chip when the date's availability check re-renders it).
                        if (draft.fields.bkSlotFrom) $('#bkSlotFrom').trigger('change');

                        // Re-run availability check so dateAvailable is restored after modal reopen
                        // (The change handler draws the date in the selected-date bar and marks its calendar cell.)
                        if (draft.fields.bookDate) $('#bookDate').trigger('change');

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
                            'color:#60a5fa;font-size:12px;padding:9px 14px;margin:16px 0 12px;border-radius:6px;' +
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

        // Reset wizard when the drawer closes (draft intentionally preserved for reopen).
        // atl:drawerClosed fires from closeAtlDrawer() on every close path alike (X button,
        // backdrop, Escape, or a programmatic close from the success/duplicate-clash flows
        // above) — one listener covers what 'hide.bs.modal' (flushBkDraft, run first, same
        // order Bootstrap fired them in) and 'hidden.bs.modal' (this reset) did separately.
        document.addEventListener('atl:drawerClosed', function(e) {
            if (!e.detail || e.detail.id !== 'bookingDrawer') return;
            flushBkDraft();
            // Keep what the visitor typed so reopening restores it ("draft preserved for reopen").
            // Not after a successful submit — that draft was cleared on purpose.
            if (!$('#bookSuccessScreen').is(':visible')) saveBkDraft(true);
            // Reset only once the slide-out has finished (--t: .35s in css/public/redesign.css).
            // Resetting straight away would visibly blank the wizard while the drawer is still on
            // screen (the old modal reset on 'hidden.bs.modal', i.e. after its fade). Skipped if the
            // drawer was reopened in the meantime.
            setTimeout(function () {
            if ($('#bookingDrawer').hasClass('atl-drawer--open')) return;
            _venueInited = false; // allow fresh init + event rebind next open
            isSubmitting = false;
            $bookingForm[0].reset();
            $('.manual-address-toggle-wrap').hide();
            // Leftovers of the previous session that form.reset() doesn't touch: venue feedback + the slot grid
            // (its chips belonged to the old date) and the "select a slot" readout.
            $('#venueStatus').hide().empty();
            $('#venueSelected').hide().empty();
            $('#venueDropdown').empty().hide();
            $('#bookAddress, #bookCity, #bookCountry').data('bkAuto', false);
            $('#bkTimeSlotsGrid').empty().removeAttr('aria-busy');
            $('#bkSmartReadout').hide();
            $('#bkServicesTableBody').empty();
            $('#bkServicesTableWrap').hide();
            _bkDraftSuppressed = true;    // updateProgress saves a draft; the form was just reset
            updateProgress(1);
            _bkDraftSuppressed = false;
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
            if (window.bkResetDateDisplay) window.bkResetDateDisplay();
            $('#bkClearDraftBtn').hide();
            $('#bkDraftBanner').remove();
            $('#bkPrefillNote').remove();
            }, 400);
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
            if (window.bkResetDateDisplay) window.bkResetDateDisplay();
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
        // Capture latest progress when the visitor leaves before submitting. The drawer-close
        // case is now handled inside the atl:drawerClosed listener above (flushBkDraft runs
        // first there, same order Bootstrap's hide.bs.modal/hidden.bs.modal fired in).
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
    // The visible background is the <img> inside .login-bg (admin.html), not a CSS background on
    // <body> — that img sits on top of and fully obscures body, so a body background-image is
    // never actually visible. Swap the img's src directly instead.
    var DEFAULT_LOGIN_BG = 'images/background/thabiso_login_background_1920x1080.png';
    window.applyAdminBackgrounds = function() {
        if (!document.body.classList.contains('admin-body') && !document.body.classList.contains('login-page-bg')) return;

        var dashSec = document.getElementById('dashboardSection');
        var isDashboard = dashSec && (dashSec.style.display !== 'none');
        var loginBg = window.tmLoginBg || null;
        var loginBgImg = document.querySelector('.login-bg img');
        if (!loginBgImg) return;

        loginBgImg.src = (!isDashboard && loginBg) ? loginBg : DEFAULT_LOGIN_BG;
    };

    // Initial application is left to admin.html's own branding fetch (which calls
    // applyAdminBackgrounds() once real data arrives) and the auth-check's later calls — not here.
    // A blind setTimeout used to run this at a fixed 100ms, but on a page this size that fires long
    // before the branding fetch (further down the document) even starts, so it always ran with
    // window.tmLoginBg still undefined and reset the image back to the default — visible as a flash
    // back to the default background sandwiched between the real login image and its correct value.

    // ==========================================
    // ADMIN DASHBOARD SIDEBAR LOGIC — removed 2026-09-24, see below.
    // ==========================================
    // This block targeted #tmAdminSidebar / #tmSidebarToggle, which exist only on
    // admin.html — the `if ($tmSidebar.length)` guard already made it a no-op on the
    // public page this file otherwise serves, so removing it changes nothing there.
    //
    // On admin.html it was a SECOND, independent click handler on the same toggle
    // button admin.html's own script (near the end of <body>) also binds — a
    // '.toggleClass(\'collapsed\')' one-liner with no awareness of the multilevel
    // sidebar, padding-left, FullCalendar re-measure, or sessionStorage persistence
    // that admin.html's handler owns. Because this file loads first (line ~6909, well
    // before admin.html's own sidebar script near the bottom of <body>), it always
    // fired FIRST on every click. Traced with a MutationObserver on .className:
    //
    //     +0.0ms   class -> "tm-admin-sidebar collapsed"   (THIS handler toggled it)
    //     +11.7ms  class -> "tm-admin-sidebar"              (admin.html's handler ran
    //                                                         next, read the class THIS
    //                                                         handler had just changed,
    //                                                         and — correctly, for what
    //                                                         it could see — toggled it
    //                                                         right back)
    //
    // Net effect: the FIRST click on the toggle was a no-op (reported as "sections
    // don't work"/sidebar stuck), and the mobile open/close + tab-close-on-mobile
    // duplicated here matched admin.html's own openMobileSidebar/closeMobileSidebar
    // exactly, so they added a second no-op collision there too, not a mobile-only bug.
    // admin.html's implementation is a strict superset; nothing here needs to survive.

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

    // state.seq numbers every month request so a slow, older response can never overwrite a newer one
    // (rapid month navigation). state.error means the last request failed — the grid then says so instead
    // of showing every date as if it were confirmed available.
    // months: per-month availability views already loaded, keyed 'YYYY-MM' ({ held, booked, full, error }).
    // verdicts: what the server's per-date check said about individual dates ('avail' | 'partial' | 'held' | 'soon' |
    // 'full' | 'unknown'), reported by the booking wizard - fresher than the month view, so it wins for that date.
    // inspect: a not-bookable date the visitor tapped to see why (nothing is booked). msg: the wizard's message for
    // the currently chosen date (see renderSelectedDate).
    var state = { year: 0, month: 0, months: {}, verdicts: {}, inspect: null, msg: null, loading: false, error: false, nonWorkingDows: [], minAdvanceHours: 0, seq: 0, focusDate: null };
    var DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

    function pad(n) { return n < 10 ? '0' + n : '' + n; }

    function toDateStr(d) {
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    }
    function fromDateStr(ds) {
        var p = ds.split('-');
        return new Date(+p[0], +p[1] - 1, +p[2]);
    }
    // "Monday, 5 October 2026" — for the selected-date display, aria-labels and the review step.
    function longDate(ds) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(ds || '')) return ds || '';
        var d = fromDateStr(ds);
        return DAYS[d.getDay()] + ', ' + d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear();
    }
    window.bkLongDate = longDate;

    var _workingDaysFetched = false;
    // One request for all seven weekdays (each request counts against the per-IP budget, and this
    // used to be seven of them on every page load). A server that doesn't know dow=all answers
    // without a `days` array — only then fall back to one request per weekday. A failed request
    // (e.g. rate-limited) fails open with every weekday treated as working, as it always has, and
    // does NOT fan out into more requests.
    function fetchWorkingDays(cb) {
        if (_workingDaysFetched) { cb(); return; }
        // bypassInterceptor: failures here are handled inline by the calendar itself — no extra error toast.
        fetch('/api/public/booking-config?dow=all', { bypassInterceptor: true })
            .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(function(cfg) {
                if (!cfg || !Array.isArray(cfg.days)) { fetchWorkingDaysPerDay(cb); return; }
                _workingDaysFetched = true;
                state.nonWorkingDows = cfg.days
                    .filter(function(d) { return d.is_working_day === false; })
                    .map(function(d) { return d.day_of_week; });
                // The server's minimum-notice rule (GET /api/public/availability answers "too_soon" inside it).
                state.minAdvanceHours = Number(cfg.min_advance_hours) || 0;
                cb();
            })
            .catch(function() { _workingDaysFetched = true; cb(); });
    }
    function fetchWorkingDaysPerDay(cb) {
        Promise.all([0,1,2,3,4,5,6].map(function(d) {
            return fetch('/api/public/booking-config?dow=' + d)
                .then(function(r) { return r.json(); })
                .catch(function() { return { is_working_day: true }; });
        })).then(function(configs) {
            _workingDaysFetched = true;
            state.nonWorkingDows = [];
            configs.forEach(function(cfg, idx) {
                if (cfg.is_working_day === false) state.nonWorkingDows.push(idx);
                if (cfg.min_advance_hours) state.minAdvanceHours = Number(cfg.min_advance_hours) || state.minAdvanceHours;
            });
            cb();
        }).catch(function() {
            _workingDaysFetched = true;
            cb();
        });
    }

    // Loading / error line under the month title (role=status, so it is announced).
    function setCalStatus(kind) {
        var el = document.getElementById('calStatus');
        if (!el) return;
        if (kind === 'loading') {
            el.className = 'tm-cal-status tm-cal-status--loading';
            el.innerHTML = '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> Loading availability…';
        } else if (kind === 'error') {
            el.className = 'tm-cal-status tm-cal-status--error';
            el.innerHTML = '<i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> We couldn\'t load live availability, so these dates aren\'t confirmed. You can still pick a date and we\'ll check it. <button type="button" id="calRetry" class="tm-cal-retry">Try again</button>';
        } else {
            el.className = 'tm-cal-status';
            el.textContent = '';
        }
    }

    // Previous-month button is disabled at the current month (it used to silently do nothing).
    function updateCalNav() {
        var prevBtn = document.getElementById('calPrev');
        if (!prevBtn) return;
        var now = new Date();
        var atCurrent = state.year < now.getFullYear() || (state.year === now.getFullYear() && state.month <= now.getMonth() + 1);
        prevBtn.disabled = atCurrent;
        prevBtn.setAttribute('aria-disabled', atCurrent ? 'true' : 'false');
    }

    function dropVerdicts(monthKey) {
        Object.keys(state.verdicts).forEach(function(ds) { if (ds.slice(0, 7) === monthKey) delete state.verdicts[ds]; });
    }

    function fetchAndRender() {
        var seq = ++state.seq;
        var monthKey = state.year + '-' + pad(state.month);
        state.loading = true;
        state.error = false;
        document.getElementById('calTitle').textContent = MONTHS[state.month - 1] + ' ' + state.year;
        updateCalNav();
        setCalStatus('loading');
        var grid = document.getElementById('calDaysGrid');
        if (grid) { grid.classList.add('tm-cal-days--loading'); grid.setAttribute('aria-busy', 'true'); }

        fetch('/api/public/availability/month?year=' + state.year + '&month=' + state.month, { bypassInterceptor: true })
            .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(function(data) {
                if (seq !== state.seq) return;          // a newer month request superseded this one
                // full = reserved AND the whole day is taken (not selectable)
                state.months[monthKey] = { held: data.held || [], booked: data.booked || [], full: data.full || [], error: false };
                dropVerdicts(monthKey);                 // this fresh month view supersedes earlier per-date answers
                state.loading = false;
                renderGrid();
            })
            .catch(function() {
                if (seq !== state.seq) return;
                // Do NOT pretend the month is clear: keep the dates selectable (the server re-checks the
                // chosen date), but mark them "not confirmed" and say so.
                state.months[monthKey] = { held: [], booked: [], full: [], error: true };
                dropVerdicts(monthKey);
                state.loading = false;
                state.error = true;
                renderGrid();
            });
    }

    // ── ONE state per date ──────────────────────────────────────────────────────────────────────────
    // dateState(ds) is the single place a date's availability is decided. The calendar cell (renderGrid) and the
    // selected-date bar (renderSelectedDate) both call it and write its `key` as data-state; the state -> colour
    // mapping exists once, in css/public/redesign.css. Inputs, in precedence order: past / closed weekday (known
    // client-side) - the server's answer for THIS date (state.verdicts) - the month view (held / booked / full) -
    // the minimum-notice rule. Mirrors what can actually be booked: past / closed / blocked win over reserved.
    var STATE_ICON = {
        none: 'fa-regular fa-calendar', avail: 'fa-solid fa-circle-check', booked: 'fa-solid fa-clock', held: 'fa-solid fa-circle-xmark',
        nonworking: 'fa-solid fa-circle-minus', past: 'fa-solid fa-circle-minus', soon: 'fa-solid fa-circle-minus', unknown: 'fa-solid fa-circle-question'
    };

    function dateState(ds, now, todayStart) {
        now = now || new Date();
        if (!todayStart) { todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0); }
        var date = fromDateStr(ds);
        var notice = 'bookings need at least ' + state.minAdvanceHours + ' hours\' notice';
        if (date < todayStart) return { key: 'past', tip: 'Past date', msg: 'This date has passed — pick a later one.', clickable: false };
        if (state.nonWorkingDows.indexOf(date.getDay()) >= 0) return { key: 'nonworking', tip: 'Not a working day', msg: 'Not a working day — pick another date.', clickable: false };
        var m = state.months[ds.slice(0, 7)];               // that month's view, once loaded
        var v = state.verdicts[ds];                          // what the per-date check said about exactly this date
        var held = v ? v === 'held' : !!m && m.held.indexOf(ds) >= 0;
        var full = v ? v === 'full' : !!m && m.full.indexOf(ds) >= 0;
        var partial = v ? v === 'partial' : !!m && m.booked.indexOf(ds) >= 0;
        // Same rule the server applies to the chosen date (midnight of that day vs now).
        var soon = v === 'soon' || (state.minAdvanceHours > 0 && (date.getTime() - now.getTime()) < state.minAdvanceHours * 3600000);
        var unconfirmed = v ? v === 'unknown' : (!m || m.error);
        if (held) return { key: 'held', tip: 'Blocked', msg: 'This date is blocked.', clickable: false };
        // An untimed booking/event occupies the whole day: the per-date check would refuse it, so it is shown as
        // reserved (orange) but is not selectable.
        if (full) return { key: 'booked', extra: ' tm-cal-cell--full', tip: 'Reserved — the whole day is taken', msg: 'Reserved — this whole day is taken. Please choose another date.', icon: 'fa-solid fa-calendar-xmark', clickable: false };
        if (soon) return { key: 'soon', tip: 'Too soon — ' + notice, msg: 'Too soon — ' + notice + '.', clickable: false };
        if (unconfirmed) return { key: 'unknown', tip: 'Availability not confirmed — select to check this date', msg: 'Availability not confirmed yet.', clickable: true };
        if (partial) return { key: 'booked', tip: 'Reserved — other times may still be open', msg: 'Reserved — some times are taken, other times are still open.', clickable: true };
        return { key: 'avail', tip: 'Available', msg: 'This date is available!', clickable: true };
    }

    // Marks the selected cell: the chosen booking date, or a not-bookable date the visitor tapped to see why.
    function markSelected() {
        var grid = document.getElementById('calDaysGrid');
        if (!grid) return;
        var input = document.getElementById('bookDate');
        var sel = (input && input.value) || state.inspect || '';
        Array.prototype.forEach.call(grid.querySelectorAll('.tm-cal-cell[data-date]'), function(c) {
            var on = c.getAttribute('data-date') === sel;
            c.classList.toggle('tm-cal-cell--selected', on);
            c.classList.toggle('tm-cal-cell--inspect', on && !c.classList.contains('tm-cal-cell--clickable'));
            if (on) c.setAttribute('aria-pressed', 'true'); else c.removeAttribute('aria-pressed');
        });
    }

    // The selected-date bar (#bookDateDisplay): the chosen date, its state (data-state -> colour, icon, wording) and
    // the wizard's message for it. Always redrawn from dateState() - the same call that draws the cell - so the two
    // agree by construction; it is a no-op when nothing it shows has changed (it is a live region).
    function renderSelectedDate() {
        var box = document.getElementById('bookDateDisplay');
        if (!box) return;
        var input = document.getElementById('bookDate');
        var picked = input ? input.value : '';
        var ds = picked || state.inspect || '';
        var m = state.msg && state.msg.ds === picked ? state.msg : null;
        var key, text, msg, icon;
        if (!ds) {
            key = 'none'; text = 'No date selected — pick one from the calendar above.'; icon = STATE_ICON.none;
            msg = m && m.kind === 'text' ? m.html : '';
        } else {
            var st = dateState(ds);
            key = st.key; text = longDate(ds); icon = st.icon || STATE_ICON[st.key];
            if (m && m.kind === 'loading') { msg = m.html; icon = 'fa-solid fa-spinner fa-spin'; }
            else msg = m && m.html ? m.html : st.msg;
        }
        var sig = [key, text, msg, icon].join('|');
        if (box._sig === sig) return;
        box._sig = sig;
        box.setAttribute('data-state', key);
        box.querySelector('.bk-date-status__date').textContent = text;
        box.querySelector('.bk-date-status__msg').innerHTML = msg;      // server / static wording (+ our own suggestion link)
        box.querySelector('.bk-date-status__icon').className = 'bk-date-status__icon ' + icon;
    }

    // A click / Enter on a date. Bookable -> it becomes the booking date (the wizard's change handler then runs the
    // per-date check). Not bookable (closed, blocked, past, whole day taken) -> nothing is booked, but the date is
    // still shown - ringed and explained in its state colour - so a phone visitor (no hover tooltips) learns why.
    function pickDate(ds) {
        var input = document.getElementById('bookDate');
        if (!input) return;
        var st = dateState(ds);
        var disp = document.getElementById('bookDateDisplay');
        if (disp) disp.classList.remove('bk-input--err');
        state.msg = null;
        if (st.clickable) { state.inspect = null; input.value = ds; }
        else { state.inspect = ds; input.value = ''; }
        // Fire jQuery change so the existing availability pre-check runs (with no date it clears the gate and Next).
        if (typeof $ !== 'undefined') $('#bookDate').trigger('change');
        markSelected();
        renderSelectedDate();
        // The answer is drawn just under the grid: if that spot is off-screen (or under the sticky Back/Next row, e.g. after
        // tapping a date in the last week on a phone) bring it into view - scroll-margin-bottom on the bar keeps it clear of that row.
        var bar = document.getElementById('bookDateDisplay');
        if (bar && bar.scrollIntoView) bar.scrollIntoView({ block: 'nearest' });
    }

    function renderGrid() {
        var grid = document.getElementById('calDaysGrid');
        if (!grid) return;

        var now = new Date();
        var todayStart = new Date(now); todayStart.setHours(0,0,0,0);
        var todayStr = toDateStr(todayStart);
        var firstDow = new Date(state.year, state.month - 1, 1).getDay();
        var daysInMonth = new Date(state.year, state.month, 0).getDate();
        // Keyboard focus survives a redraw (e.g. when the server's answer for a date changes its state).
        var focusedDs = grid.contains(document.activeElement) ? document.activeElement.getAttribute('data-date') : null;
        var cells = [];

        for (var blank = 0; blank < firstDow; blank++) {
            cells.push('<div class="tm-cal-cell tm-cal-cell--empty" aria-hidden="true"></div>');
        }

        for (var d = 1; d <= daysInMonth; d++) {
            var ds   = state.year + '-' + pad(state.month) + '-' + pad(d);
            var st   = dateState(ds, now, todayStart);
            var isToday = ds === todayStr;

            var cls = 'tm-cal-cell tm-cal-cell--' + st.key + (st.extra || '');
            if (st.clickable) cls += ' tm-cal-cell--clickable';
            if (isToday)      cls += ' tm-cal-cell--today';

            var label = longDate(ds) + (isToday ? ' (today)' : '') + ' — ' + st.tip;
            cells.push(
                '<div class="' + cls + '" data-date="' + ds + '" data-state="' + st.key + '" title="' + st.tip.replace(/"/g, '&quot;') + '"' +
                ' role="button" tabindex="-1" aria-label="' + label.replace(/"/g, '&quot;') + '"' +
                (st.clickable ? '' : ' aria-disabled="true"') + (isToday ? ' aria-current="date"' : '') +
                '>' + d + '</div>'
            );
        }

        grid.innerHTML = cells.join('');
        markSelected();                                  // the chosen / inspected date, if it is in this month
        grid.classList.remove('tm-cal-days--loading');
        grid.removeAttribute('aria-busy');
        setCalStatus(state.error ? 'error' : '');

        // First load only: if nothing left in this month can be picked (late in the month, with the notice
        // window, closed days…), land on the next month instead of a month of greyed-out dates.
        if (state.autoAdvance) {
            state.autoAdvance = false;
            if (!grid.querySelector('.tm-cal-cell--clickable') && gotoMonth(state.year, state.month)) return;
        }

        // Roving tabindex: ONE Tab stop for the whole grid (selected date, else today, else first bookable).
        var stop = grid.querySelector('.tm-cal-cell--selected')
            || grid.querySelector('.tm-cal-cell--today.tm-cal-cell--clickable')
            || grid.querySelector('.tm-cal-cell--clickable');
        if (stop) stop.setAttribute('tabindex', '0');

        // Arrow-key navigation crossed a month boundary: land on the intended day once it is rendered.
        var refocus = state.focusDate || focusedDs;
        if (refocus) {
            var target = grid.querySelector('.tm-cal-cell[data-date="' + refocus + '"]');
            state.focusDate = null;
            if (target) {
                Array.prototype.forEach.call(grid.querySelectorAll('[tabindex="0"]'), function(x) { x.setAttribute('tabindex', '-1'); });
                target.setAttribute('tabindex', '0');
                target.focus({ preventScroll: true });
            }
        }
        renderSelectedDate();
    }

    // The booking wizard reports what the server's per-date check said about a date. It is recorded, and if that
    // changes the date's state the cell is redrawn - together with the bar - so both show the fresher answer.
    window.bkNoteDateVerdict = function(ds, v) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(ds || '')) return;
        var sig = function(s) { return s.key + (s.extra || '') + s.clickable; };
        var before = sig(dateState(ds));
        state.verdicts[ds] = v;
        if (sig(dateState(ds)) !== before && !state.loading) renderGrid();   // (a month load in flight redraws when it lands)
        else renderSelectedDate();
    };
    // The wizard's message for the chosen date ('' clears; 'loading' shows the spinner).
    window.bkSetDateMessage = function(kind, html) {
        var input = document.getElementById('bookDate');
        state.msg = kind ? { ds: input ? input.value : '', kind: kind, html: html || '' } : null;
        renderSelectedDate();
    };
    window.bkRefreshDateDisplay = function() { markSelected(); renderSelectedDate(); };
    // Back to "no date selected" (wizard reset / cleared draft).
    window.bkResetDateDisplay = function() {
        var input = document.getElementById('bookDate');
        if (input) input.value = '';
        var disp = document.getElementById('bookDateDisplay');
        if (disp) disp.classList.remove('bk-input--err');
        state.inspect = null; state.msg = null;
        markSelected();
        renderSelectedDate();
    };
    // Select a date from outside the grid (the "Try <date> instead" suggestion): flips to its month first.
    window.bkPickDate = function(ds) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(ds || '')) return;
        if (ds.slice(0, 7) !== state.year + '-' + pad(state.month)) gotoMonth(+ds.slice(0, 4), +ds.slice(5, 7) - 1);
        pickDate(ds);
    };

    function gotoMonth(year, month0, focusDate) {
        var d = new Date(year, month0, 1);
        var nowFloor = new Date(); nowFloor.setDate(1); nowFloor.setHours(0,0,0,0);
        if (d < nowFloor) return false;                 // never navigate to past months
        state.year  = d.getFullYear();
        state.month = d.getMonth() + 1;
        state.focusDate = focusDate || null;
        fetchAndRender();
        return true;
    }

    function init() {
        var calEl = document.getElementById('availabilityCalendar');
        if (!calEl) return;

        var now = new Date();
        state.year  = now.getFullYear();
        state.month = now.getMonth() + 1;

        var prevBtn = document.getElementById('calPrev');
        var nextBtn = document.getElementById('calNext');
        var grid    = document.getElementById('calDaysGrid');

        prevBtn.addEventListener('click', function() { gotoMonth(state.year, state.month - 2); });
        nextBtn.addEventListener('click', function() { gotoMonth(state.year, state.month); });
        calEl.addEventListener('click', function(e) {
            if (e.target && e.target.id === 'calRetry') fetchAndRender();
        });

        // Delegated: the grid is rebuilt on every month change.
        grid.addEventListener('click', function(e) {
            var el = e.target.closest ? e.target.closest('.tm-cal-cell[data-date]') : null;
            if (el && grid.contains(el)) pickDate(el.getAttribute('data-date'));
        });
        grid.addEventListener('keydown', function(e) {
            var el = e.target.closest ? e.target.closest('.tm-cal-cell[data-date]') : null;
            if (!el) return;
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();                    // also stops Space scrolling the drawer
                pickDate(el.getAttribute('data-date'));
                return;
            }
            var cur = fromDateStr(el.getAttribute('data-date'));
            var target = null;
            if (e.key === 'ArrowLeft')       target = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() - 1);
            else if (e.key === 'ArrowRight') target = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 1);
            else if (e.key === 'ArrowUp')    target = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() - 7);
            else if (e.key === 'ArrowDown')  target = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 7);
            else if (e.key === 'Home')       target = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() - cur.getDay());
            else if (e.key === 'End')        target = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + (6 - cur.getDay()));
            else if (e.key === 'PageUp')     target = new Date(cur.getFullYear(), cur.getMonth() - 1, Math.min(cur.getDate(), new Date(cur.getFullYear(), cur.getMonth(), 0).getDate()));
            else if (e.key === 'PageDown')   target = new Date(cur.getFullYear(), cur.getMonth() + 1, Math.min(cur.getDate(), new Date(cur.getFullYear(), cur.getMonth() + 2, 0).getDate()));
            if (!target) return;
            e.preventDefault();
            var ts = toDateStr(target);
            var inView = grid.querySelector('.tm-cal-cell[data-date="' + ts + '"]');
            if (inView) {
                Array.prototype.forEach.call(grid.querySelectorAll('[tabindex="0"]'), function(x) { x.setAttribute('tabindex', '-1'); });
                inView.setAttribute('tabindex', '0');
                inView.focus();
            } else {
                gotoMonth(target.getFullYear(), target.getMonth(), ts);
            }
        });

        updateCalNav();
        state.autoAdvance = true;
        fetchWorkingDays(function() { fetchAndRender(); });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // Allow other scripts to force-refresh (e.g. after admin action)
    window.refreshAvailCalendar = function() {
        fetchAndRender();
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
        if (window.openAtlDrawer) openAtlDrawer('trackingDrawer');

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
