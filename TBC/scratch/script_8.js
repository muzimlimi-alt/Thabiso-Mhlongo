
        document.getElementById('forcePwdForm')?.addEventListener('submit', async function(e) {
            e.preventDefault();
            const btn = document.getElementById('forcePwdBtn');
            const errorDiv = document.getElementById('forcePwdError');
            const pwd1 = document.getElementById('forceNewPwd').value;
            const pwd2 = document.getElementById('forceConfirmPwd').value;

            if(pwd1 !== pwd2) {
                errorDiv.innerText = "Passwords do not match.";
                errorDiv.style.display = 'block';
                return;
            }
            if(pwd1.length < 8) {
                errorDiv.innerText = "Password must be at least 8 characters long.";
                errorDiv.style.display = 'block';
                return;
            }

            btn.disabled = true;
            btn.innerText = 'Updating...';
            errorDiv.style.display = 'none';

            try {
                const response = await fetch('/api/admin/force-change-password', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ newPassword: pwd1 })
                });
                const result = await response.json();

                if (result.success) {
                    btn.innerText = 'Success!';
                    sessionStorage.removeItem('admin_force_password_change');
                    setTimeout(() => {
                        document.getElementById('forcePasswordChangeOverlay').style.display = 'none';
                        window.location.reload();
                    }, 1000);
                } else {
                    errorDiv.innerText = result.message || "Failed to update password.";
                    errorDiv.style.display = 'block';
                    btn.innerText = 'Change Password';
                    btn.disabled = false;
                }
            } catch (err) {
                errorDiv.innerText = "Connection error.";
                errorDiv.style.display = 'block';
                btn.innerText = 'Change Password';
                btn.disabled = false;
            }
        });
    