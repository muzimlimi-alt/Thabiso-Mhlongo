// Permission registry — canonical source of truth for every module+action pair and system-role
// default grants. Pure data, no DB. Consumed by lib/rbac-schema.js (seed) and lib/rbac-engine.js
// (runtime resolution). Keep this in sync whenever a new route module is added.

// Every section/route-domain the admin portal has, with the action verbs it supports.
// Keys use kebab-case to match route conventions; labels are human-readable for the matrix UI.
const MODULES = {
    dashboard:           { label: 'Dashboard',           actions: ['view'] },
    notifications:       { label: 'Notifications',       actions: ['view', 'manage'] },
    bookings:            { label: 'Bookings',             actions: ['view', 'create', 'edit', 'delete', 'approve', 'export', 'manage'] },
    calendar:            { label: 'Calendar',             actions: ['view', 'create', 'edit', 'delete', 'manage'] },
    events:              { label: 'Events',               actions: ['view', 'create', 'edit', 'delete', 'approve', 'manage'] },
    finance:             { label: 'Finance',              actions: ['view', 'create', 'edit', 'delete', 'approve', 'export', 'manage'] },
    payments:            { label: 'Payments',             actions: ['view', 'create', 'edit', 'manage'] },
    invoices:            { label: 'Invoices',             actions: ['view', 'create', 'edit', 'delete', 'approve', 'manage'] },
    services:            { label: 'Services',             actions: ['view', 'create', 'edit', 'delete', 'manage'] },
    'payment-setup':     { label: 'Payment Setup',        actions: ['view', 'edit', 'manage'] },
    inquiries:           { label: 'Inquiries',            actions: ['view', 'create', 'edit', 'delete', 'approve', 'export', 'manage', 'assign'] },
    newsletter:          { label: 'Newsletter',           actions: ['view', 'create', 'edit', 'delete', 'approve', 'export', 'manage'] },
    social:              { label: 'Social Media',         actions: ['view', 'create', 'edit', 'delete', 'manage'] },
    contact:             { label: 'Contact Details',      actions: ['view', 'edit', 'manage'] },
    'site-content':      { label: 'Site Content',         actions: ['view', 'create', 'edit', 'delete', 'manage'] },
    'business-profile':  { label: 'Business Profile',     actions: ['view', 'edit', 'export', 'manage'] },
    legal:               { label: 'Legal & Compliance',   actions: ['view', 'create', 'edit', 'delete', 'manage'] },
    branding:            { label: 'Branding',             actions: ['view', 'edit', 'manage'] },
    integrations:        { label: 'Integrations',         actions: ['view', 'edit', 'manage'] },
    settings:            { label: 'Settings',             actions: ['view', 'edit', 'manage'] },
    users:               { label: 'User Management',      actions: ['view', 'create', 'edit', 'delete', 'manage'] },
    roles:               { label: 'Roles & Permissions',  actions: ['view', 'create', 'edit', 'delete', 'manage'] },
    security:            { label: 'Security & Audit',     actions: ['view', 'export', 'manage'] },
    'email-logs':        { label: 'Email Logs',           actions: ['view', 'export'] },
    'email-banners':     { label: 'Email Banners',        actions: ['view', 'create', 'edit', 'delete', 'manage'] },
    'direct-email':      { label: 'Direct Email',         actions: ['view', 'create'] },
};

// Permissions that touch money, credentials, or access control. The engine and matrix UI use
// this to flag high-impact changes and require extra confirmation before saves.
const SENSITIVE_PERMISSIONS = new Set([
    'payments.create', 'payments.edit', 'payments.manage',
    'payment-setup.view', 'payment-setup.edit', 'payment-setup.manage',
    'integrations.view', 'integrations.edit', 'integrations.manage',
    'settings.view', 'settings.edit', 'settings.manage',
    'business-profile.manage',
    'users.create', 'users.edit', 'users.delete', 'users.manage',
    'roles.create', 'roles.edit', 'roles.delete', 'roles.manage',
    'security.manage', 'security.export',
    'finance.approve', 'finance.delete',
    'invoices.delete', 'invoices.approve',
    'bookings.delete',
    'newsletter.export',
    'inquiries.export',
]);

// Default grants per system role. Exactly mirrors the current requireRole / nav-config access
// tiers — zero behaviour change on migrate.
//
// administrator: '*' means every permission derived from MODULES.
// manager: OPS tier (bookings/finance/newsletter/business-profile) + ALL tier sections.
// assistant: ALL tier sections only, no finance/newsletter/business-profile/credentials.
const ROLE_DEFAULTS = {
    administrator: '*',

    manager: [
        // ALL-tier sections (manager already has these in the current system)
        'dashboard.view',
        'notifications.view', 'notifications.manage',
        'bookings.view', 'bookings.create', 'bookings.edit', 'bookings.delete',
        'bookings.approve', 'bookings.export', 'bookings.manage',
        'calendar.view', 'calendar.create', 'calendar.edit', 'calendar.delete', 'calendar.manage',
        'events.view', 'events.create', 'events.edit', 'events.delete', 'events.approve', 'events.manage',
        'services.view', 'services.create', 'services.edit', 'services.delete', 'services.manage',
        'inquiries.view', 'inquiries.create', 'inquiries.edit', 'inquiries.delete',
        'inquiries.approve', 'inquiries.export', 'inquiries.manage', 'inquiries.assign',
        'social.view', 'social.create', 'social.edit', 'social.delete', 'social.manage',
        'contact.view', 'contact.edit', 'contact.manage',
        'site-content.view', 'site-content.create', 'site-content.edit', 'site-content.manage',
        'legal.view', 'legal.create', 'legal.edit', 'legal.delete', 'legal.manage',
        'direct-email.view', 'direct-email.create',
        'email-banners.view', 'email-banners.create', 'email-banners.edit', 'email-banners.manage',
        // OPS-tier extras (finance, payments, invoices, newsletter, business-profile)
        'finance.view', 'finance.create', 'finance.edit', 'finance.delete',
        'finance.approve', 'finance.export', 'finance.manage',
        'payments.view', 'payments.create', 'payments.edit', 'payments.manage',
        'invoices.view', 'invoices.create', 'invoices.edit', 'invoices.delete',
        'invoices.approve', 'invoices.manage',
        'newsletter.view', 'newsletter.create', 'newsletter.edit', 'newsletter.delete',
        'newsletter.approve', 'newsletter.export', 'newsletter.manage',
        'business-profile.view', 'business-profile.export',
    ],

    assistant: [
        'dashboard.view',
        'notifications.view',
        'bookings.view', 'bookings.create', 'bookings.edit', 'bookings.approve', 'bookings.manage',
        'calendar.view', 'calendar.create', 'calendar.edit', 'calendar.manage',
        'events.view', 'events.create', 'events.edit', 'events.manage',
        'services.view', 'services.create', 'services.edit',
        'inquiries.view', 'inquiries.create', 'inquiries.edit', 'inquiries.manage', 'inquiries.assign',
        'social.view', 'social.create', 'social.edit', 'social.manage',
        'contact.view',
        'site-content.view', 'site-content.create', 'site-content.edit', 'site-content.manage',
        'legal.view',
        'direct-email.view', 'direct-email.create',
    ],
};

// All permission keys derived from MODULES.
function allPermissionKeys() {
    return Object.entries(MODULES).flatMap(([mod, def]) =>
        def.actions.map(action => `${mod}.${action}`)
    );
}

// Expand defaults for a role key into a flat array of '<module>.<action>' strings.
function allPermissionsForRole(roleKey) {
    if (ROLE_DEFAULTS[roleKey] === '*') return allPermissionKeys();
    return ROLE_DEFAULTS[roleKey] || [];
}

module.exports = { MODULES, SENSITIVE_PERMISSIONS, ROLE_DEFAULTS, allPermissionKeys, allPermissionsForRole };
