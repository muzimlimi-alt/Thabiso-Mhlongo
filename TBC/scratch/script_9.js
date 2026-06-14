
        $(document).on('click', '.cancel-booking-btn', function(e) {
            e.stopPropagation();
            const id = $(this).data('id');
            $('#cancelBookingId').val(id);
            $('#cancelReasonDropdown').val('');
            $('#cancelNotes').val('');
            $('#cancelConfirmCheck').prop('checked', false);
            $('#submitCancelBtn').prop('disabled', true);
            
            $('#cancelPreviewArea').hide();
            $('#cancelPreviewLoading').show();
            $('#cancelModal').modal('show');
            
            fetch('/api/admin/bookings/' + id + '/cancellation-preview', { credentials: 'same-origin' })
                .then(r => r.json())
                .then(d => {
                    $('#cancelPreviewLoading').hide();
                    if(d.success) {
                        $('#prevTotalPaid').text('R ' + d.preview.totalPaid.toFixed(2));
                        $('#prevPolicy').text(d.preview.rule);
                        $('#prevRetention').text('R ' + d.preview.retention.toFixed(2));
                        $('#prevRefund').text('R ' + d.preview.refund.toFixed(2));
                        $('#cancelPreviewArea').fadeIn();
                    } else {
                        window.notificationService.showError('Preview Error', d.message);
                        $('#cancelModal').modal('hide');
                    }
                })
                .catch(err => {
                    $('#cancelPreviewLoading').hide();
                    window.notificationService.showError('Preview Error', 'Network error calculating refund.');
                    $('#cancelModal').modal('hide');
                });
        });

        $('#cancelConfirmCheck').on('change', function() {
            $('#submitCancelBtn').prop('disabled', !this.checked || !$('#cancelReasonDropdown').val());
        });
        
        $('#cancelReasonDropdown').on('change', function() {
            $('#submitCancelBtn').prop('disabled', !$('#cancelConfirmCheck').prop('checked') || !this.value);
        });

        $('#submitCancelBtn').on('click', function() {
            const id = $('#cancelBookingId').val();
            const reasonType = $('#cancelReasonDropdown').val();
            const notes = $('#cancelNotes').val();
            
            $(this).prop('disabled', true).text('Cancelling...');
            
            fetch('/api/admin/bookings/' + id + '/cancel', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reason: 'Cancellation requested via admin', cancelled_by: reasonType, notes: notes })
            })
            .then(r => r.json())
            .then(d => {
                if(d.success) {
                    window.notificationService.showSuccess('Cancellation Complete', 'Booking cancelled successfully.');
                    $('#cancelModal').modal('hide');
                    setTimeout(() => { if(typeof loadBookings === 'function') loadBookings(); }, 500);
                } else {
                    window.notificationService.showError('Cancellation Failed', d.message);
                }
            })
            .catch(err => {
                window.notificationService.showError('Cancellation Error', 'Network error.');
            })
            .finally(() => {
                $(this).text('Execute Cancellation');
            });
        });

        // Promote Booking Yes Click
        $('#btnPromoteBookingYes').on('click', function() {
            const bkId = $('#promoteBookingModalId').val();
            const bkName = $('#promoteBookingModalName').text();
            const bkDate = $('#promoteBookingModalDate').text();
            const bkVenue = $('#promoteBookingModalVenue').text();
            
            $('#promoteBookingModal').modal('hide');
            
            // Switch to events tab
            $('.um-tab-btn[data-target="#eventsAdmin"]').click();
            
            // Pre-fill form
            $('#eventsForm')[0].reset();
            $('#eventsId').val('');
            $('#eventsTitle').val(bkName);
            $('#eventsVenue').val(bkVenue !== 'TBD' ? bkVenue : '');
            $('#eventsBookingId').val(bkId);
            
            if (bkDate) {
                var d = new Date(bkDate);
                if (!isNaN(d)) {
                    $('#eventsDate').val(d.toISOString().substring(0, 16));
                }
            }
            
            // Show badge
            $('#eventsLinkedBookingBadge').show();
            $('#eventsConflictResolutionGroup').hide();
            $('#eventsBlockType').val('none');
            
            $('#eventsSubmitBtn').html('<i class="fa-solid fa-calendar-check"></i> Add Event');
            
            setTimeout(() => {
                $('html, body').animate({ scrollTop: $("#eventsAdmin").offset().top - 50 }, 500);
                $('#eventsTitle').focus();
            }, 300);
        });

        // --- CSP DELEGATED LISTENERS ---
        // Hover handled by CSS (.bkr-card-hd:hover); legacy inline-style override removed.

        $(document).on('click', '.promoted-badge', function(e) {
            e.stopPropagation();
            $('.um-tab-btn[data-target="#eventsAdmin"]').click();
        });

        $(document).on('click', '.btn-log-expense', function() {
            $('#expenseModal').modal('show');
        });

        $(document).on('click', '.recon-row', function(e) {
            if ($(e.target).is('input')) return;
            const bid = $(this).data('booking-id');
            if (typeof toggleReconDetail === 'function') toggleReconDetail(bid, this);
        });

        $(document).on('blur', '.recon-note-input', function() {
            const txId = $(this).data('tx-id');
            const note = $(this).val();
            if (typeof saveReconNote === 'function') saveReconNote(txId, note);
        });

        $(document).on('click', '.btn-svc-edit', function() {
            const id = $(this).data('id');
            if (typeof editService === 'function') editService(id);
        });

        $(document).on('click', '.btn-svc-delete', function() {
            const id = $(this).data('id');
            if (typeof deleteService === 'function') deleteService(id);
        });
    