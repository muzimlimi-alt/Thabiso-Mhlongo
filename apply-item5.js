/* Item 5 — split Preferences into Gateway + Notifications inner tabs; persistent Save outside panels. */
const fs = require('fs');
let h = fs.readFileSync('admin.html', 'utf8');
function rep(name, oldS, newS) {
  const i = h.indexOf(oldS);
  if (i === -1) throw new Error('NOT FOUND: ' + name);
  if (h.indexOf(oldS, i + 1) !== -1) throw new Error('NOT UNIQUE: ' + name);
  h = h.replace(oldS, newS);
}

/* A — 3-tab bar + open Gateway panel + rename icon-header. */
rep('A-tabbar',
`                            <div class="atl-tab-bar" role="tablist">
                                <button class="atl-tab-btn active" data-um-tab="prefPanelSettings" role="tab" aria-selected="true"><i class="fa-solid fa-sliders"></i> System Settings</button>
                                <button class="atl-tab-btn" data-um-tab="prefPanelAbout" role="tab" aria-selected="false"><i class="fa-solid fa-circle-info"></i> About</button>
                            </div>
                            <div class="um-panel active" id="prefPanelSettings">
                            <div class="atl-card">
                                <div class="um-icon-header">
                                    <div class="um-icon-header__icon"><i class="fa-solid fa-sliders"></i></div>
                                    <div>
                                        <h4 class="um-section-label" style="margin-bottom:4px;">System Settings</h4>
                                        <p class="um-section-desc">Configure PayFast credentials and email (SMTP) settings. Saved values take effect immediately without a restart.</p>
                                    </div>
                                </div>`,
`                            <div class="atl-tab-bar" role="tablist">
                                <button class="atl-tab-btn active" data-um-tab="prefPanelGateway" role="tab" aria-selected="true"><i class="fa-solid fa-credit-card"></i> Payments &amp; Email</button>
                                <button class="atl-tab-btn" data-um-tab="prefPanelNotifications" role="tab" aria-selected="false"><i class="fa-solid fa-bell"></i> Notifications</button>
                                <button class="atl-tab-btn" data-um-tab="prefPanelAbout" role="tab" aria-selected="false"><i class="fa-solid fa-circle-info"></i> About</button>
                            </div>
                            <div class="um-panel active" id="prefPanelGateway">
                            <div class="atl-card">
                                <div class="um-icon-header">
                                    <div class="um-icon-header__icon"><i class="fa-solid fa-credit-card"></i></div>
                                    <div>
                                        <h4 class="um-section-label" style="margin-bottom:4px;">Payments &amp; Email</h4>
                                        <p class="um-section-desc">PayFast credentials and SMTP mail settings. Saved values take effect immediately without a restart.</p>
                                    </div>
                                </div>`);

/* B1 — after SMTP, close Gateway panel + open Notifications panel (drop redundant inner h4). */
rep('B1-split',
`                                    <div class="col-md-6">
                                        <div class="um-field-group"><label class="um-label" for="stSmtpPass">SMTP Password</label><div class="um-input-wrap"><i class="fa-solid fa-lock um-input-icon"></i><input type="password" class="um-input" id="stSmtpPass" placeholder="app password"></div></div>
                                    </div>
                                </div>
                                <h4 class="um-section-label" style="font-size:13px; margin-top:18px;"><i class="fa-solid fa-bell" style="margin-right:8px; color:var(--atl-amber);"></i>Notifications</h4>
                                <div class="row">
                                    <div class="col-md-8">`,
`                                    <div class="col-md-6">
                                        <div class="um-field-group"><label class="um-label" for="stSmtpPass">SMTP Password</label><div class="um-input-wrap"><i class="fa-solid fa-lock um-input-icon"></i><input type="password" class="um-input" id="stSmtpPass" placeholder="app password"></div></div>
                                    </div>
                                </div>
                            </div>
                            </div>
                            <div class="um-panel" id="prefPanelNotifications">
                            <div class="atl-card">
                                <div class="um-icon-header">
                                    <div class="um-icon-header__icon"><i class="fa-solid fa-bell"></i></div>
                                    <div>
                                        <h4 class="um-section-label" style="margin-bottom:4px;">Notifications</h4>
                                        <p class="um-section-desc">Where new-booking alerts are delivered. Use &ldquo;Send Test&rdquo; to confirm email works.</p>
                                    </div>
                                </div>
                                <div class="row">
                                    <div class="col-md-8">`);

/* B2 — close Notifications panel; remove the inline Save button. */
rep('B2-close',
`                                    <div class="col-md-4" style="display:flex;align-items:flex-end;padding-bottom:15px;">
                                        <button type="button" class="atl-btn atl-btn--ghost btn-block" id="testNotifBtn" onclick="sendTestNotification()">
                                            <i class="fa-solid fa-paper-plane" style="margin-right:5px;"></i>Send Test
                                        </button>
                                    </div>
                                </div>
                                <button id="btnSaveSystemSettings" class="atl-btn atl-btn--primary btn-block" onclick="saveSystemSettings(this)">
                                    <i class="fa-solid fa-floppy-disk" style="margin-right:6px;"></i>Save System Settings
                                </button>
                            </div>
                            </div>
                            <div class="um-panel" id="prefPanelAbout">`,
`                                    <div class="col-md-4" style="display:flex;align-items:flex-end;padding-bottom:15px;">
                                        <button type="button" class="atl-btn atl-btn--ghost btn-block" id="testNotifBtn" onclick="sendTestNotification()">
                                            <i class="fa-solid fa-paper-plane" style="margin-right:5px;"></i>Send Test
                                        </button>
                                    </div>
                                </div>
                            </div>
                            </div>
                            <div class="um-panel" id="prefPanelAbout">`);

/* C — persistent Save button after all panels (always visible; saves all fields). */
rep('C-save',
`                                    <p class="um-section-desc" style="margin-top:18px;"><i class="fa-solid fa-bolt" style="color:var(--atl-amber); margin-right:6px;"></i>Saved values take effect immediately &mdash; no server restart needed.</p>
                                </div>
                            </div>`,
`                                    <p class="um-section-desc" style="margin-top:18px;"><i class="fa-solid fa-bolt" style="color:var(--atl-amber); margin-right:6px;"></i>Saved values take effect immediately &mdash; no server restart needed.</p>
                                </div>
                            </div>
                            <div style="margin-top:18px;">
                                <button id="btnSaveSystemSettings" class="atl-btn atl-btn--primary btn-block" onclick="saveSystemSettings(this)">
                                    <i class="fa-solid fa-floppy-disk" style="margin-right:6px;"></i>Save System Settings
                                </button>
                            </div>`);

fs.writeFileSync('admin.html', h, 'utf8');
console.log('OK: Item 5 — Preferences split into Gateway + Notifications + About.');
