
    /* About Me Rich Text Editors — initialised after Quill loads */
    (function() {
        try {
            if (typeof Quill === 'undefined') return;
            var aboutToolbar = [
                ['bold', 'italic', 'underline'],
                [{ 'list': 'ordered' }, { 'list': 'bullet' }],
                ['link'],
                ['clean']
            ];
            window.aboutQuill1 = new Quill('#aboutEditorP1', { theme: 'snow', placeholder: 'Lead paragraph — introduce Thabiso…', modules: { toolbar: aboutToolbar } });
            window.aboutQuill2 = new Quill('#aboutEditorP2', { theme: 'snow', placeholder: 'Second paragraph…', modules: { toolbar: aboutToolbar } });
            window.aboutQuill3 = new Quill('#aboutEditorP3', { theme: 'snow', placeholder: 'Third paragraph…', modules: { toolbar: aboutToolbar } });
            [window.aboutQuill1, window.aboutQuill2, window.aboutQuill3].forEach(function(q) {
                q.on('text-change', function() { if (typeof updateAboutPreview === 'function') updateAboutPreview(); });
            });
            if (typeof loadAboutData === 'function') loadAboutData();
        } catch(e) { console.warn('About Me editor init failed:', e); }
    })();

    /* Newsletter Rich Text Editor — initialised last to avoid interfering with sidebar/other scripts */
    (function() {
        try {
            if (typeof Quill === 'undefined' || !document.getElementById('newsletterEditor')) return;
            var toolbarOptions = [
                [{ 'header': [1, 2, 3, false] }],
                ['bold', 'italic', 'underline', 'strike'],
                [{ 'color': [] }, { 'background': [] }],
                [{ 'list': 'ordered' }, { 'list': 'bullet' }],
                ['link', 'image'],
                ['clean']
            ];
            window.newsletterQuill = new Quill('#newsletterEditor', {
                theme: 'snow',
                placeholder: 'Compose your newsletter here. Use the toolbar to format text and embed images...',
                modules: { toolbar: toolbarOptions }
            });
        } catch (e) {
            console.warn('Newsletter editor init failed:', e);
        }
    })();
