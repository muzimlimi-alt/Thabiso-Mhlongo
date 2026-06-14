
        function toggleForgotPassword(e) {
            e.preventDefault();
            const loginCard = document.getElementById('loginCard');
            const forgotCard = document.getElementById('forgotPasswordCard');
            if (loginCard.style.display === 'none') {
                loginCard.style.display = 'block';
                forgotCard.style.display = 'none';
                document.getElementById('forgotMessage').style.display = 'none';
            } else {
                loginCard.style.display = 'none';
                forgotCard.style.display = 'block';
            }
        }

        // Password Visibility Toggle
        document.getElementById('togglePass')?.addEventListener('click', function() {
            const passInput = document.getElementById('adminPassword');
            const icon = this.querySelector('i');
            if (passInput.type === 'password') {
                passInput.type = 'text';
                icon.classList.replace('fa-eye', 'fa-eye-slash');
            } else {
                passInput.type = 'password';
                icon.classList.replace('fa-eye-slash', 'fa-eye');
            }
        });

        // Forgot Password Handle
        document.getElementById('adminForgotForm')?.addEventListener('submit', async function(e) {
            e.preventDefault();
            const email = document.getElementById('forgotEmail').value;
            const msgBox = document.getElementById('forgotMessage');
            const btn = document.getElementById('forgotBtn');

            btn.disabled = true;
            btn.innerText = "Sending...";
            msgBox.style.display = 'none';

            try {
                const response = await fetch('/api/admin/forgot-password', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email })
                });
                const result = await response.json();

                msgBox.className = result.success ? "alert alert-success" : "alert alert-danger";
                msgBox.innerText = result.message;
                msgBox.style.display = 'block';

                if (result.success) {
                    document.getElementById('forgotEmail').value = "";
                }
            } catch (err) {
                console.error("Forgot password error", err);
                msgBox.className = "alert alert-danger";
                msgBox.innerText = "Error securely dispatching request.";
                msgBox.style.display = 'block';
            } finally {
                btn.disabled = false;
                btn.innerText = "Send Reset Link";
            }
        });
    