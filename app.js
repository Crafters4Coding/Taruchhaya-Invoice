let customers = [];
let products = [];
let orders = [];
let paymentHistory = [];
let cloudRevision = null;
let cloudLoad = null;
let cloudWrite = false;
let cloudRefreshQueued = false;
let signedIn = false;
let pendingSaveKey;

let currentCustomer = null;
let cart = []; // Array of { productId, quantity, price, name }
let editingCustomerId = null;
let editingProductId = null;
let editingOrderId = null;
let editingOrderSnapshot;
let orderReviewRevision;
let paymentReviewRevision;
let billsCustomerId = null;
let currentBillsFilter = 'all'; // 'all' | 'unpaid' | 'paid'

function getInvoiceNumber(order) {
    if (!order || !order.id) return '';
    const parts = order.id.split('_');
    if (parts[1] === 'v2' && parts.length === 3) return 'TE-N-' + parts[2];
    if (parts.length >= 3) {
        return 'TE-' + parts[2];
    }
    // Fallback: if it's an old order ID like ord_1716912345678
    if (parts.length === 2 && !isNaN(parts[1])) {
        const ts = parseInt(parts[1], 10);
        const d = new Date(ts);
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        const serial = String(ts % 10000).padStart(4, '0');
        return `TE-${yyyy}${mm}${dd}-${serial}`;
    }
    return order.id;
}

// --- Unified Accounting & Dues Helper Functions ---
function getOrderTotal(order) {
    if (!order) return 0;
    const directTotal = parseFloat(order.totalAmount ?? order.total_amount);
    if (directTotal > 0 || (directTotal === 0 && String(order.id).startsWith('ord_v2_'))) {
        return roundMoney(directTotal);
    }
    // Calculate from items + extra costs
    const itemsSum = (order.items || []).reduce((sum, item) => {
        const p = parseFloat(item.price) || 0;
        const q = parseFloat(item.quantity) || 0;
        return sum + getLineTotal({ price: p, quantity: q });
    }, 0);
    const addCost = parseFloat(order.additionalCost ?? order.additional_cost ?? 0) || 0;
    const prevDue = parseFloat(order.previousDue ?? order.previous_due ?? 0) || 0;
    const computed = itemsSum + addCost + prevDue;
    return roundMoney(computed);
}

function getOrderPaid(order) {
    if (!order) return 0;
    const paid = parseFloat(order.paidAmount ?? order.paid_amount ?? 0);
    return Number.isFinite(paid) ? Math.max(0, roundMoney(paid)) : 0;
}

function getOrderDue(order) {
    if (!order) return 0;
    const total = getOrderTotal(order);
    const paid = getOrderPaid(order);
    const due = roundMoney(total - paid);
    return due > 0.005 ? due : 0;
}

function orderBelongsToCustomer(order, customer) {
    if (!order || !customer || !customer.id) return false;
    if (order.customerId != null && String(order.customerId).trim()) {
        return String(order.customerId).trim() === String(customer.id).trim();
    }

    // Only legacy bills without an ID may fall back to a unique phone or name.
    const phone = String(order.customerPhone || '').replace(/\D/g, '');
    const name = (order.customerName || '').trim().toLowerCase();
    const phoneMatches = phone.length >= 7
        ? customers.filter(c => String(c.phone || '').replace(/\D/g, '') === phone)
        : [];
    const matches = phoneMatches.length || !name
        ? phoneMatches
        : customers.filter(c => c.name.trim().toLowerCase() === name);
    return matches.length === 1 && String(matches[0].id) === String(customer.id);
}

function isOrderAdjusted(order) {
    return !!order?.adjustedWithOrderId && orders.some(o => o.id === order.adjustedWithOrderId);
}

function getPayableOrders(customer) {
    if (!customer) return [];
    return orders.filter(order => orderBelongsToCustomer(order, customer) &&
        !isOrderAdjusted(order) && getOrderDue(order) > 0)
        .sort((a, b) => new Date(a.date) - new Date(b.date));
}

function escapeHtml(value) {
    const characters = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return String(value ?? '').replace(/[&<>"']/g, character => characters[character]);
}

function htmlArgument(value) {
    return escapeHtml(JSON.stringify(String(value)));
}

function roundMoney(amount) {
    if (!Number.isFinite(amount)) return amount;
    const [coefficient, exponent = '0'] = String(Math.abs(amount)).split('e');
    return Math.sign(amount) * Math.round(Number(coefficient + 'e' + (Number(exponent) + 2))) / 100;
}

function getLineTotal(item) {
    const price = Number(item.price);
    const quantity = Number(item.quantity);
    if (!Number.isFinite(price * quantity) || !price || !quantity) return 0;
    const [priceDigits, priceScale] = decimalParts(price);
    const [quantityDigits, quantityScale] = decimalParts(quantity);
    const digits = priceDigits * quantityDigits;
    const scale = priceScale + quantityScale - 2;
    const cents = scale > 0
        ? (digits + 10n ** BigInt(scale) / 2n) / 10n ** BigInt(scale)
        : digits * 10n ** BigInt(-scale);
    return Math.sign(price * quantity) * Number(cents) / 100;
}

function decimalParts(value) {
    const [coefficient, exponent = '0'] = String(Math.abs(value)).split('e');
    const [whole, fraction = ''] = coefficient.split('.');
    return [BigInt(whole + fraction), fraction.length - Number(exponent)];
}

function getItemsTotal(items) {
    return roundMoney(items.reduce((sum, item) => sum + getLineTotal(item), 0));
}

function getOrderRevenue(order) {
    return roundMoney(getOrderTotal(order) - (Number(order.previousDue) || 0));
}

function getCustomerTotalDue(customer) {
    return roundMoney(getPayableOrders(customer).reduce((sum, order) => sum + getOrderDue(order), 0));
}

// --- Supabase Cloud Sync Logic ---
// You can enter your credentials here to hardcode them, 
// or set them dynamically from the "Cloud Settings" modal in the application.
const SUPABASE_URL = "https://cofigoxqaltwdetcodug.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNvZmlnb3hxYWx0d2RldGNvZHVnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk4ODI1NDMsImV4cCI6MjA5NTQ1ODU0M30.7ZXIY6e8MNlMQb08nDNOe69cSlTl8M6xlJOKw8_h3wE";

let supabaseClient = null;

function initSupabase() {
    if (supabaseClient) return true;
    const url = localStorage.getItem('taruchhaya_supabase_url') || SUPABASE_URL || '';
    const key = localStorage.getItem('taruchhaya_supabase_key') || SUPABASE_KEY || '';

    if (url && key) {
        try {
            if (window.supabase) {
                supabaseClient = window.supabase.createClient(url, key, { auth: { storage: sessionStorage, storageKey: 'taruchhaya_auth' } });
                return true;
            }
        } catch (e) {
            console.error('Supabase initialization failed:', e);
        }
    }
    supabaseClient = null;
    return false;
}

function updateCloudStatus(status, errorMsg = '') {
    const star = document.getElementById('cloudStatusStar');
    const starMobile = document.getElementById('cloudStatusStarMobile');
    const statusText = document.getElementById('cloudStatusText');

    let color = '#ef4444'; // Red
    let title = 'Not connected to cloud';

    if (status === 'connected') {
        color = '#10b981'; // Green
        title = 'Connected to Supabase Cloud';
    } else if (status === 'syncing') {
        color = '#3b82f6'; // Blue
        title = 'Syncing with Supabase...';
    } else if (status === 'error') {
        color = '#f59e0b'; // Yellow/Orange
        title = 'Sync Error: ' + errorMsg;
    }

    if (star) {
        star.style.color = color;
        star.style.textShadow = `0 0 5px ${color}66`;
        star.title = title;
    }
    if (starMobile) {
        starMobile.style.color = color;
        starMobile.style.textShadow = `0 0 5px ${color}66`;
        starMobile.title = title;
    }
    if (statusText) {
        statusText.textContent = title;
        statusText.style.color = color;
    }
}

function loadCloudData() {
    if (!signedIn) return;
    if (cloudWrite || cloudLoad) {
        cloudRefreshQueued = true;
        return cloudLoad;
    }
    cloudLoad = refreshCloudSnapshot().finally(() => {
        cloudLoad = null;
        flushCloudRefresh();
    });
    return cloudLoad;
}

function flushCloudRefresh() {
    if (!cloudRefreshQueued) return;
    cloudRefreshQueued = false;
    loadCloudData();
}

async function refreshCloudSnapshot() {
    updateCloudStatus('syncing');
    try {
        const { data, error } = await supabaseClient.rpc('taruchhaya_changes', { since_revision: cloudRevision });
        if (error) throw error;
        if (!signedIn) return;
        cloudRevision = data.revision;
        if (data.customers !== null) customers = data.customers.map(r => ({ id: r.id, name: r.name, phone: r.phone || '', address: r.address || '', createdAt: r.created_at }));
        if (data.products !== null) products = data.products.map(r => ({ id: r.id, name: r.name, price: Number(r.price), unit: r.unit || 'pcs' }));
        if (data.orders !== null) orders = data.orders.map(r => ({
            id: r.id, customerId: r.customer_id, customerName: r.customer_name || '',
            items: r.items || [], itemsTotal: Number(r.items_total || 0), previousDue: Number(r.previous_due || 0),
            additionalCost: Number(r.additional_cost || 0), additionalCostReason: r.additional_cost_reason || '',
            totalAmount: r.total_amount == null ? null : Number(r.total_amount), paidAmount: Number(r.paid_amount || 0),
            date: r.date, customerAddress: r.customer_address, customerPhone: r.customer_phone, adjustedWithOrderId: r.adjusted_with_order_id || null
        }));
        if (data.payments !== null) paymentHistory = data.payments.map(r => ({
            id: r.id, customerId: r.customer_id, customerName: r.customer_name || '', amount: Number(r.amount),
            mode: r.mode || 'Cash', date: r.date, details: r.details
        }));
        renderCloudSnapshot();
        updateCloudStatus('connected');
    } catch (err) {
        updateCloudStatus('error', err.message);
    }
}

function renderCloudSnapshot() {
    // Re-render UI while maintaining active selection if applicable
    const activeCustVal = document.getElementById('customerSelect') ? document.getElementById('customerSelect').value : '';
    const activeProdVal = document.getElementById('productSelect') ? document.getElementById('productSelect').value : '';
    renderCustomerSelect(document.getElementById('customerSearch') ? document.getElementById('customerSearch').value : '');
    renderProductSelect(document.getElementById('productSearch') ? document.getElementById('productSearch').value : '');
    if (activeCustVal) {
        const custSelect = document.getElementById('customerSelect');
        if (custSelect && Array.from(custSelect.options).some(o => o.value === activeCustVal)) {
            custSelect.value = activeCustVal;
        }
    }
    if (activeProdVal) {
        const prodSelect = document.getElementById('productSelect');
        if (prodSelect && Array.from(prodSelect.options).some(o => o.value === activeProdVal)) {
            prodSelect.value = activeProdVal;
        }
    }
    if (typeof renderProductsList === 'function') renderProductsList();
    renderBills();
    renderCart();

    if (typeof renderCustomersList === 'function') renderCustomersList();

    const homeView = document.getElementById('homeView');
    if (homeView && homeView.style.display !== 'none') {
        renderHomeDashboard();
    }

    const historyView = document.getElementById('historyView');
    if (historyView && historyView.style.display !== 'none') {
        renderPaymentHistory();
    }
}

function orderCloudRow(order) {
    return {
        id: order.id, customer_id: order.customerId, customer_name: order.customerName || '',
        customer_address: order.customerAddress ?? null, customer_phone: order.customerPhone ?? null,
        items: order.items || [], items_total: order.itemsTotal || 0, previous_due: order.previousDue || 0,
        additional_cost: order.additionalCost || 0, additional_cost_reason: order.additionalCostReason || '',
        total_amount: order.totalAmount, paid_amount: order.paidAmount || 0, date: order.date,
        adjusted_with_order_id: order.adjustedWithOrderId || null
    };
}

function paymentCloudRow(payment) {
    return {
        id: payment.id, customer_id: payment.customerId, customer_name: payment.customerName || '',
        amount: payment.amount, mode: payment.mode, date: payment.date, details: payment.details
    };
}

async function resolvePendingSave() {
    const id = sessionStorage.getItem(pendingSaveKey);
    if (!id) return true;
    const { data, error } = await supabaseClient.rpc('taruchhaya_save_status', { operation: id });
    if (error) return false;
    if (!data) return false;
    sessionStorage.removeItem(pendingSaveKey);
    showToast(data === 'saved' ? 'The previous save was confirmed. Check the refreshed records.' :
        'The previous save did not go through. You can enter it again.');
    return true;
}

async function saveCloudChanges(changes) {
    if (navigator.onLine === false) {
        showToast('You are offline. This change was not saved. Reconnect and try again.', 'error');
        return false;
    }
    if (!signedIn || cloudRevision === null || cloudLoad || cloudWrite) {
        showToast('Wait for the cloud connection and any current save before trying again.', 'error');
        return false;
    }
    cloudWrite = true;
    const operation = crypto.randomUUID();
    try {
        if (sessionStorage.getItem(pendingSaveKey)) {
            const resolved = await resolvePendingSave();
            if (!resolved) showToast('The previous save is still unconfirmed. Reconnect before trying again.', 'error');
            await refreshCloudSnapshot();
            return false;
        }
        sessionStorage.setItem(pendingSaveKey, operation);
        const args = { operation, expected_revision: cloudRevision, changes };
        updateCloudStatus('syncing');
        const uncertain = result => result.error && (!result.error.code || result.status >= 500);
        let result = await supabaseClient.rpc('taruchhaya_save', args);
        if (uncertain(result)) result = await supabaseClient.rpc('taruchhaya_save', args);
        if (result.error) {
            if (uncertain(result)) {
                showToast('Save could not be confirmed. Reconnect and check the records before re-entering it.', 'error');
            } else {
                sessionStorage.removeItem(pendingSaveKey);
                showToast(result.error.message || 'The cloud rejected this save.', 'error');
            }
            await refreshCloudSnapshot();
            return false;
        }
        sessionStorage.removeItem(pendingSaveKey);
        // A confirmed write can be followed by a failed read. Keep the last visible data and
        // its old revision so a subsequent save cannot overwrite the newer cloud snapshot.
        await refreshCloudSnapshot();
        return true;
    } catch (err) {
        updateCloudStatus('error', err.message);
        showToast('Save could not be confirmed. Check the records after reconnecting.', 'error');
        return false;
    } finally {
        cloudWrite = false;
        flushCloudRefresh();
    }
}

async function refreshOnReconnect() {
    if (!signedIn || cloudWrite || cloudLoad) return;
    if (sessionStorage.getItem(pendingSaveKey) && await resolvePendingSave()) {
        await loadCloudData();
        return;
    }
    await loadCloudData();
}

document.addEventListener('DOMContentLoaded', async () => {
    if (!initSupabase()) {
        document.getElementById('sessionStatus').textContent = 'Could not connect to sign-in. Reload to try again.';
        return;
    }
    const { data, error } = await supabaseClient.auth.getUser();
    if (error || !data.user) {
        window.location.replace('login.html');
        return;
    }
    signedIn = true;
    pendingSaveKey = 'taruchhaya_pending_' + data.user.id;
    supabaseClient.auth.onAuthStateChange(event => {
        if (event === 'SIGNED_OUT') endSession();
    });
    window.addEventListener('online', refreshOnReconnect);
    window.addEventListener('focus', refreshOnReconnect);
    window.addEventListener('pagehide', () => document.body.classList.add('checking-session'));
    window.addEventListener('pageshow', async event => {
        if (!event.persisted) return;
        const { data, error } = await supabaseClient.auth.getUser();
        if (error || !data.user) {
            endSession();
            return;
        }
        document.body.classList.remove('checking-session');
        refreshOnReconnect();
    });

    const today = new Date().toLocaleDateString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });
    document.getElementById('sidebarDate').textContent = today;
    document.getElementById('mobileHeaderDate').textContent = today;
    document.getElementById('sessionStatus').hidden = true;
    document.body.classList.remove('checking-session');
    switchView('homeView');
    await refreshOnReconnect();
    supabaseClient.channel('taruchhaya-sync')
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'taruchhaya_revision' }, () => loadCloudData())
        .subscribe();
});

// --- Modal Logic ---

function openModal(modalId) {
    document.getElementById(modalId).style.display = 'flex';
}

function closeModal(modalId) {
    document.getElementById(modalId).style.display = 'none';
    if (modalId === 'customerModal') {
        editingCustomerId = null;
        document.getElementById('newCustomerName').value = '';
        document.getElementById('newCustomerPhone').value = '';
        const addressInput = document.getElementById('newCustomerAddress');
        if (addressInput) addressInput.value = '';
        const title = document.querySelector('#customerModal h2');
        if (title) title.textContent = 'Add New Customer';
        const btn = document.querySelector('#customerForm button[type="submit"]');
        if (btn) btn.textContent = 'Save Customer';
    }
    if (modalId === 'productModal') {
        editingProductId = null;
        document.getElementById('newProductName').value = '';
        document.getElementById('newProductPrice').value = '';
        const unitInput = document.getElementById('newProductUnit');
        if (unitInput) unitInput.value = 'pcs';
        const title = document.querySelector('#productModal h2');
        if (title) title.textContent = 'Add New Product';
        const btn = document.querySelector('#productForm button[type="submit"]');
        if (btn) btn.textContent = 'Save Product';
    }
}

// Close modal when clicking outside
window.onclick = function (event) {
    if (event.target.classList.contains('modal')) {
        event.target.style.display = 'none';
    }
};

// --- Customer Management ---
function editCustomer(id) {
    const customer = customers.find(c => c.id === id);
    if (!customer) return;
    editingCustomerId = id;
    document.getElementById('newCustomerName').value = customer.name;
    document.getElementById('newCustomerPhone').value = customer.phone || '';
    const addressInput = document.getElementById('newCustomerAddress');
    if (addressInput) addressInput.value = customer.address || '';
    const title = document.querySelector('#customerModal h2');
    if (title) title.textContent = 'Edit Customer';
    const btn = document.querySelector('#customerForm button[type="submit"]');
    if (btn) btn.textContent = 'Update Customer';
    openModal('customerModal');
}

async function saveCustomer(e) {
    e.preventDefault();
    const name = document.getElementById('newCustomerName').value.trim();
    const phone = document.getElementById('newCustomerPhone').value.trim();
    const address = document.getElementById('newCustomerAddress').value.trim();
    if (!name || !phone) {
        showToast('Customer name and phone number are required.', 'error');
        return;
    }
    const existing = customers.find(c => c.id === editingCustomerId);
    if (editingCustomerId && !existing) {
        showToast('This customer is no longer available.', 'error');
        return;
    }
    const id = existing?.id || 'cust_' + crypto.randomUUID();
    if (!await saveCloudChanges({ customer: { id, name, phone, address, created_at: existing?.createdAt || new Date().toISOString() } })) return;
    closeModal('customerModal');
    if (!existing && customers.some(c => c.id === id)) selectCustomerFromCombobox(id);
    showToast(existing ? 'Customer updated.' : 'Customer added.');
}

async function deleteCustomer(id) {
    const customer = customers.find(c => c.id === id);
    if (!customer) return;
    const hasHistory = () => orders.some(o => orderBelongsToCustomer(o, customer)) ||
        paymentHistory.some(p => String(p.customerId) === String(id));
    if (hasHistory()) {
        showToast('This customer has bills or payments. Keep the profile to preserve their records.', 'error');
        return;
    }
    if (!await showCustomConfirm('Delete ' + customer.name + '?') || hasHistory()) return;
    if (!await saveCloudChanges({ delete_customer: id })) return;
    if (currentCustomer?.id === id) {
        currentCustomer = null;
        cart = [];
        document.getElementById('customerSearch').value = '';
        updateOrderStepUI();
        renderCart();
    }
    showToast('Customer deleted.');
}

function renderCustomerSelect(filterTerm = '') {
    const select = document.getElementById('customerSelect');
    if (!select) return;
    const currentVal = select.value; // Preserve current selection if possible
    select.innerHTML = '<option value="">-- Select a Customer --</option>';

    let sortedCustomers = [...customers].sort((a, b) => a.name.localeCompare(b.name));

    if (filterTerm) {
        const term = filterTerm.toLowerCase();
        sortedCustomers = sortedCustomers.filter(c => c.name.toLowerCase().includes(term) || (c.phone && c.phone.includes(term)));
    }

    sortedCustomers.forEach(cust => {
        const option = document.createElement('option');
        option.value = cust.id;
        option.textContent = `${cust.name}${cust.phone ? ` (${cust.phone})` : ''}`;
        select.appendChild(option);
    });

    const addNewOption = document.createElement('option');
    addNewOption.value = 'add_new';
    addNewOption.textContent = '+ Add New Customer';
    addNewOption.style.fontWeight = 'bold';
    select.appendChild(addNewOption);

    let shouldAutoSelect = false;
    let autoSelectId = null;

    if (filterTerm && sortedCustomers.length === 1) {
        autoSelectId = sortedCustomers[0].id;
        if (currentVal !== autoSelectId) {
            shouldAutoSelect = true;
        }
    }

    if (shouldAutoSelect) {
        select.value = autoSelectId;
        select.size = 1;
        handleCustomerChange();
    } else if (currentVal && customers.some(c => c.id === currentVal)) {
        select.value = currentVal;
        select.size = 1;
    }

    if (filterTerm && sortedCustomers.length > 1) {
        try {
            select.showPicker();
        } catch (e) {
            select.size = Math.min(sortedCustomers.length + 2, 6);
        }
    } else {
        select.size = 1;
    }
}

async function handleCustomerChange() {
    const select = document.getElementById('customerSelect');
    if (!select) return;
    select.size = 1; // Reset size if it was expanded
    const newSelectedId = select.value;

    if (newSelectedId === 'add_new') {
        openModal('customerModal');
        select.value = currentCustomer ? currentCustomer.id : '';
        return;
    }

    // If cart has items, warn the user before switching customers
    if (cart.length > 0 && newSelectedId !== (currentCustomer ? currentCustomer.id : '')) {
        const confirmed = await showCustomConfirm('Changing customer will clear the current cart. Proceed?');
        if (!confirmed) {
            // Revert the dropdown back to the previous customer
            select.value = currentCustomer ? currentCustomer.id : '';
            return;
        }
        // Clear cart since user confirmed
        cart = [];
        renderCart();
    }

    if (newSelectedId) {
        currentCustomer = customers.find(c => c.id === newSelectedId) || null;
    } else {
        currentCustomer = null;
    }

    renderCart();
    updateOrderStepUI();
}


// --- Product Management ---
function editProduct(id) {
    const product = products.find(p => p.id === id);
    if (!product) return;
    editingProductId = id;
    document.getElementById('newProductName').value = product.name;
    document.getElementById('newProductPrice').value = product.price;
    const unitInput = document.getElementById('newProductUnit');
    if (unitInput) unitInput.value = product.unit || 'pcs';
    const title = document.querySelector('#productModal h2');
    if (title) title.textContent = 'Edit Product';
    const btn = document.querySelector('#productForm button[type="submit"]');
    if (btn) btn.textContent = 'Update Product';
    openModal('productModal');
}

async function saveProduct(e) {
    e.preventDefault();
    const name = document.getElementById('newProductName').value.trim();
    const price = parseFloat(document.getElementById('newProductPrice').value);
    const unit = document.getElementById('newProductUnit').value || 'pcs';
    if (!name || !Number.isFinite(price) || price < 0) {
        showToast('Please enter a valid product name and price.', 'error');
        return;
    }
    if (editingProductId && !products.some(product => product.id === editingProductId)) {
        showToast('This product is no longer available.', 'error');
        return;
    }
    const id = editingProductId || 'prod_' + crypto.randomUUID();
    if (!await saveCloudChanges({ product: { id, name, price, unit } })) return;
    closeModal('productModal');
    showToast('Product saved.');
}

async function deleteProduct(productId) {
    if (cart.some(item => item.productId === productId)) {
        showToast('Remove this product from the cart before deleting it.', 'error');
        return;
    }
    if (!await showCustomConfirm('Delete this product permanently?')) return;
    if (await saveCloudChanges({ delete_product: productId })) showToast('Product deleted.');
}

function handleProductChange() {
    const select = document.getElementById('productSelect');
    const priceOverrideInput = document.getElementById('productPriceOverride');
    if (!select || !priceOverrideInput) return;

    const productId = select.value;
    if (productId) {
        const product = products.find(p => p.id === productId);
        if (product) {
            priceOverrideInput.value = product.price.toFixed(2);
        }
    } else {
        priceOverrideInput.value = '';
    }
}

function renderProductSelect(filterTerm = '') {
    const select = document.getElementById('productSelect');
    if (!select) return;
    const currentVal = select.value;
    select.innerHTML = '<option value="">-- Select a Product --</option>';

    let sortedProducts = [...products].sort((a, b) => a.name.localeCompare(b.name));
    if (filterTerm) {
        const term = filterTerm.toLowerCase();
        sortedProducts = sortedProducts.filter(p => p.name.toLowerCase().includes(term));
    }

    sortedProducts.forEach(prod => {
        const option = document.createElement('option');
        option.value = prod.id;
        const unitDisplay = prod.unit ? ` / ${prod.unit}` : '';
        option.textContent = `${prod.name} — ₹${prod.price.toFixed(2)}${unitDisplay}`;
        select.appendChild(option);
    });

    if (filterTerm && sortedProducts.length === 1) {
        select.value = sortedProducts[0].id;
        select.size = 1;
    } else if (currentVal && products.some(p => p.id === currentVal)) {
        select.value = currentVal;
        select.size = 1;
    }

    if (filterTerm && sortedProducts.length > 1) {
        try {
            select.showPicker();
        } catch (e) {
            select.size = Math.min(sortedProducts.length + 1, 6);
        }
    } else {
        select.size = 1;
    }

    // Synchronize price override field
    handleProductChange();
}

function renderProductsList() {
    const container = document.getElementById('productsListContainer');
    if (!container) return;
    container.innerHTML = '';

    const searchInput = document.getElementById('productSearchInput');
    const query = searchInput ? searchInput.value.trim().toLowerCase() : '';

    let filtered = products;
    if (query) {
        filtered = products.filter(prod => prod.name.toLowerCase().includes(query));
    }

    if (products.length === 0) {
        container.innerHTML = '<p style="text-align:center; color:var(--text-secondary); margin-top:20px; font-style:italic;">No products found.</p>';
        return;
    }

    if (filtered.length === 0) {
        container.innerHTML = `<p style="text-align:center; color:var(--text-secondary); margin-top:20px; font-style:italic;">No products found matching "${escapeHtml(searchInput.value)}".</p>`;
        return;
    }

    const sortedProducts = [...filtered].sort((a, b) => a.name.localeCompare(b.name));

    sortedProducts.forEach(prod => {
        const unitDisplay = prod.unit ? ` / ${escapeHtml(prod.unit)}` : '';

        const card = document.createElement('div');
        card.className = 'bill-card';
        card.style.marginBottom = '15px';
        card.style.display = 'flex';
        card.style.flexDirection = 'column';
        card.style.gap = '10px';
        card.style.padding = '15px';
        card.style.border = '1px solid var(--panel-border)';
        card.style.borderRadius = '8px';
        card.style.backgroundColor = '#f8fafc';

        card.innerHTML = `
            <div>
                <h3 style="margin: 0; font-size: 1.25rem; font-weight: 700; color: #1e293b;">${escapeHtml(prod.name)}</h3>
                <div style="margin-top: 4px; display: flex; flex-direction: column; gap: 2px;">
                    <span style="font-size: 0.9rem; color: #64748b;">Unit: ${escapeHtml(prod.unit || 'pcs')}</span>
                </div>
            </div>
            
            <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; margin-top: 5px;">
                <span style="color: var(--success-color); font-weight: 700; font-size: 1.1rem; flex: 1;">
                    ₹${prod.price.toFixed(2)}${unitDisplay}
                </span>
                
                <div style="display: flex; gap: 12px; align-items: center;">
                    <button class="btn btn-secondary" style="padding: 4px 12px; font-size: 0.9rem; border-color: var(--accent-color); color: var(--accent-color); background: transparent; border-radius: 8px; display: flex; align-items: center; gap: 4px;" onclick="editProduct(${htmlArgument(prod.id)})">✏️ Edit</button>
                    
                    <button class="btn-danger" style="padding: 4px 8px; font-size: 0.9rem; border: none; background: transparent; display: flex; align-items: center; gap: 4px; cursor: pointer; color: var(--danger-color);" onclick="deleteProduct(${htmlArgument(prod.id)})">🗑️ Delete</button>
                </div>
            </div>
        `;
        container.appendChild(card);
    });
}

// --- Cart & Order Logic ---
function removeFromCart(productId) {
    cart = cart.filter(item => item.productId !== productId);
    renderCart();
}

function updateCartQuantity(productId, newQty) {
    const qty = parseFloat(newQty);
    if (!Number.isFinite(qty) || qty <= 0) {
        showToast('Enter a quantity greater than zero, or use Remove to delete the item.', 'error');
        renderCart();
        return;
    }
    const item = cart.find(i => i.productId === productId);
    if (item) {
        item.quantity = qty;
        renderCart();
    }
}

function updateCartPrice(productId, newPrice) {
    const price = parseFloat(newPrice);
    if (!Number.isFinite(price) || price < 0) {
        renderCart();
        return;
    }
    const item = cart.find(i => i.productId === productId);
    if (item) {
        item.price = price;
        renderCart();
    }
}

// --- Customer Combobox Search ---
function onCustomerSearchInput(value) {
    const dropdown = document.getElementById('customerDropdownList');
    if (!dropdown) return;

    const query = value.trim().toLowerCase();
    const filtered = customers.filter(c => c.name.toLowerCase().includes(query) || (c.phone && c.phone.includes(query)));

    dropdown.innerHTML = '';
    if (filtered.length === 0) {
        dropdown.innerHTML = `<div style="padding: 12px; text-align: center; color: var(--text-secondary); font-size: 0.88rem;">No customer found</div>`;
    } else {
        filtered.forEach(cust => {
            const totalDue = getCustomerTotalDue(cust);

            const item = document.createElement('div');
            item.style.cssText = `
                padding: 14px 16px;
                border-bottom: 1px solid var(--panel-border);
                cursor: pointer;
                display: flex;
                justify-content: space-between;
                align-items: center;
                transition: background 0.15s;
            `;
            item.onmouseover = () => item.style.background = 'rgba(37, 99, 235, 0.08)';
            item.onmouseout = () => item.style.background = 'transparent';
            item.onclick = () => selectCustomerFromCombobox(cust.id);

            item.innerHTML = `
                <div>
                    <div style="font-weight: 700; font-size: 1.05rem; color: var(--text-primary);">${escapeHtml(cust.name)}</div>
                    <div style="font-size: 0.9rem; color: var(--text-secondary); margin-top: 4px;">📞 ${escapeHtml(cust.phone || 'N/A')} ${escapeHtml(cust.address ? '· 📍 ' + cust.address : '')}</div>
                </div>
                ${totalDue > 0 ? `<span style="font-size: 0.85rem; font-weight: 700; color: var(--danger-color); background: rgba(239, 68, 68, 0.1); padding: 4px 10px; border-radius: 12px;">Due: ₹${totalDue.toFixed(2)}</span>` : '<span style="font-size: 0.85rem; font-weight: 600; color: var(--success-color); background: rgba(16, 185, 129, 0.1); padding: 4px 10px; border-radius: 12px;">No Dues</span>'}
            `;
            dropdown.appendChild(item);
        });
    }

    dropdown.style.display = 'block';
}

function selectCustomerFromCombobox(customerId) {
    const dropdown = document.getElementById('customerDropdownList');
    if (dropdown) dropdown.style.display = 'none';

    const searchInput = document.getElementById('customerSearch');
    const selected = customers.find(c => c.id === customerId);

    if (selected) {
        if (searchInput) searchInput.value = selected.name;
        currentCustomer = selected;
    }

    renderCart();
    updateOrderStepUI();
}

// Close comboboxes when clicking outside
document.addEventListener('click', (e) => {
    const custWrap = document.getElementById('customerSearch');
    const custDropdown = document.getElementById('customerDropdownList');
    if (custDropdown && custWrap && !custWrap.contains(e.target) && !custDropdown.contains(e.target)) {
        custDropdown.style.display = 'none';
    }

    const prodWrap = document.getElementById('productSearch');
    const prodDropdown = document.getElementById('productDropdownList');
    if (prodDropdown && prodWrap && !prodWrap.contains(e.target) && !prodDropdown.contains(e.target)) {
        prodDropdown.style.display = 'none';
    }
});

// --- Add Product to Cart ---
function addProductToCart(productId) {
    const product = products.find(p => p.id === productId);
    if (!product) return;

    const existingItem = cart.find(item => item.productId === productId);
    if (existingItem) {
        existingItem.quantity += 1;
    } else {
        cart.push({
            productId: product.id,
            name: product.name,
            price: product.price,
            quantity: 1,
            unit: product.unit || 'pcs'
        });
    }

    renderCart();
}

// --- Product Combobox Search ---
function onProductSearchInput(value) {
    const dropdown = document.getElementById('productDropdownList');
    if (!dropdown) return;

    const query = value.trim().toLowerCase();
    const filtered = products.filter(p => p.name.toLowerCase().includes(query));

    dropdown.innerHTML = '';
    if (filtered.length === 0) {
        dropdown.innerHTML = `<div style="padding: 12px; text-align: center; color: var(--text-secondary); font-size: 0.88rem;">No products found matching query</div>`;
    } else {
        filtered.forEach(prod => {
            const inCartItem = cart.find(i => i.productId === prod.id);

            const item = document.createElement('div');
            item.style.cssText = `
                padding: 14px 16px;
                border-bottom: 1px solid var(--panel-border);
                cursor: pointer;
                display: flex;
                justify-content: space-between;
                align-items: center;
                transition: background 0.15s;
            `;
            item.onmouseover = () => item.style.background = 'rgba(37, 99, 235, 0.08)';
            item.onmouseout = () => item.style.background = 'transparent';
            item.onclick = () => {
                addProductToCart(prod.id);
                if (dropdown) dropdown.style.display = 'none';
                const searchInput = document.getElementById('productSearch');
                if (searchInput) searchInput.value = '';
            };

            const unitDisplay = prod.unit ? ` / ${escapeHtml(prod.unit)}` : '';
            item.innerHTML = `
                <div>
                    <div style="font-weight: 700; font-size: 1.05rem; color: var(--text-primary);">${escapeHtml(prod.name)}</div>
                    <div style="font-size: 0.9rem; color: var(--accent-color); font-weight: 700; margin-top: 4px;">₹${prod.price.toFixed(2)}${unitDisplay}</div>
                </div>
                <button type="button" style="background: var(--accent-color); color: white; border: none; padding: 8px 16px; border-radius: 10px; font-weight: 700; font-size: 0.9rem; cursor: pointer; min-height: 40px; display: flex; align-items: center;">
                    ${inCartItem ? `Add More (${inCartItem.quantity})` : '＋ Add'}
                </button>
            `;
            dropdown.appendChild(item);
        });
    }

    dropdown.style.display = 'block';
}

function expandStep(stepNum) {
    if (stepNum === 1) {
        document.getElementById('step1Body').style.display = 'flex';
        document.getElementById('editStep1Btn').style.display = 'none';
        document.getElementById('customerSelectedDetails').style.display = 'none';
    }
}

function updateOrderStepUI() {
    const step1 = document.getElementById('order-step-1');
    const step2 = document.getElementById('order-step-2');
    const ind1 = document.getElementById('step-indicator-1');
    const ind2 = document.getElementById('step-indicator-2');
    const ind3 = document.getElementById('step-indicator-3');
    const lines = document.querySelectorAll('.stepper-line');
    const stickyBar = document.getElementById('stickyCartBar');
    const cartCountLabel = document.getElementById('cartCountLabel');
    const selectedCustomerLabel = document.getElementById('selectedCustomerLabel');
    const customerDetailsCard = document.getElementById('customerSelectedDetails');

    if (currentCustomer) {
        // Customer selected: lock step 1 input, display rich detail card
        ind1.classList.remove('active');
        ind1.classList.add('done');
        ind2.classList.add('active');
        ind2.classList.remove('done');
        if (lines[0]) lines[0].classList.add('active');

        if (selectedCustomerLabel) {
            selectedCustomerLabel.textContent = currentCustomer.name;
        }

        // Fill detail card with accurate total due
        const totalDue = getCustomerTotalDue(currentCustomer);

        const phoneElem = document.getElementById('custDetailPhone');
        const addrElem = document.getElementById('custDetailAddress');
        if (phoneElem) phoneElem.textContent = '📞 ' + (currentCustomer.phone || 'No Phone');
        if (addrElem) addrElem.textContent = '📍 ' + (currentCustomer.address || 'No Address');
        const dueBadge = document.getElementById('custDetailDueBadge');
        if (dueBadge) {
            dueBadge.textContent = totalDue > 0 ? `Prev Due: ₹${totalDue.toFixed(2)}` : 'No Dues';
            dueBadge.style.color = totalDue > 0 ? 'var(--danger-color)' : 'var(--success-color)';
            dueBadge.style.background = totalDue > 0 ? 'rgba(239, 68, 68, 0.1)' : 'rgba(16, 185, 129, 0.1)';
        }

        if (customerDetailsCard) customerDetailsCard.style.display = 'block';
        document.getElementById('editStep1Btn').style.display = 'inline-flex';
        document.getElementById('step1Body').style.display = 'none';
    } else {
        // No customer selected
        ind1.classList.add('active');
        ind1.classList.remove('done');
        ind2.classList.remove('active', 'done');
        ind3.classList.remove('active', 'done');
        if (lines[0]) lines[0].classList.remove('active');
        if (lines[1]) lines[1].classList.remove('active');

        if (selectedCustomerLabel) selectedCustomerLabel.textContent = 'No customer selected';
        if (customerDetailsCard) customerDetailsCard.style.display = 'none';
        document.getElementById('editStep1Btn').style.display = 'none';
        document.getElementById('step1Body').style.display = 'flex';
    }

    const itemCount = cart.length;
    if (cartCountLabel) {
        cartCountLabel.textContent = itemCount === 0 ? '0 items in cart' : `${itemCount} item${itemCount > 1 ? 's' : ''} in cart`;
    }

    const placeOrderBtn = document.getElementById('placeOrderBtn');
    if (placeOrderBtn) {
        placeOrderBtn.disabled = !(cart.length > 0 && currentCustomer);
    }

    if (cart.length > 0 && currentCustomer) {
        ind3.classList.add('active');
        ind3.classList.remove('done');
        if (lines[1]) lines[1].classList.add('active');
        if (stickyBar) stickyBar.style.display = 'flex';
    } else {
        ind3.classList.remove('active', 'done');
        if (lines[1]) lines[1].classList.remove('active');
        if (stickyBar) stickyBar.style.display = 'none';
    }
}

function renderCart() {
    const cartItemsList = document.getElementById('cartItemsList');
    const emptyMsg = document.getElementById('emptyCartMessage');
    const cartBarTotal = document.getElementById('cartBarTotal');
    const cartBarItemCount = document.getElementById('cartBarItemCount');

    if (!cartItemsList) return;

    cartItemsList.innerHTML = '';

    if (cart.length === 0) {
        if (emptyMsg) emptyMsg.style.display = 'block';
        if (cartBarTotal) cartBarTotal.textContent = '₹0.00';
        if (cartBarItemCount) cartBarItemCount.textContent = '0 items';
        updateOrderStepUI();
        return;
    }

    if (emptyMsg) emptyMsg.style.display = 'none';

    let grandTotal = 0;

    cart.forEach(item => {
        const itemTotal = getLineTotal(item);
        grandTotal += itemTotal;

        const card = document.createElement('div');
        card.className = 'cart-item-card';
        card.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: flex-start; width: 100%; gap: 8px;">
                <div style="flex: 1; min-width: 0;">
                    <div style="font-weight: 700; font-size: 1.05rem; color: var(--text-primary); line-height: 1.35; word-break: break-word;">${escapeHtml(item.name)}</div>
                    <div style="display: flex; align-items: center; gap: 6px; margin-top: 6px; flex-wrap: wrap;">
                        <span style="font-size: 0.88rem; font-weight: 600; color: var(--text-secondary);">Rate: ₹</span>
                        <input type="number" value="${item.price.toFixed(2)}" step="0.01" min="0" onchange="updateCartPrice(${htmlArgument(item.productId)}, this.value)" style="width: 90px; padding: 5px 8px; border: 1.5px solid var(--panel-border); border-radius: 8px; font-size: 0.98rem; font-weight: 700; color: var(--accent-color); background: var(--input-bg); outline: none;">
                        <span style="font-size: 0.85rem; color: var(--text-secondary);">/ ${escapeHtml(item.unit || 'pcs')}</span>
                    </div>
                </div>
                <button onclick="removeFromCart(${htmlArgument(item.productId)})" style="background: rgba(239,68,68,0.1); border: none; color: var(--danger-color); font-size: 1.15rem; width: 36px; height: 36px; border-radius: 10px; display: flex; align-items: center; justify-content: center; cursor: pointer; flex-shrink: 0;" title="Remove">✕</button>
            </div>
            
            <div style="display: flex; justify-content: space-between; align-items: center; width: 100%; margin-top: 2px; padding-top: 8px; border-top: 1px dashed rgba(0,0,0,0.08);">
                <div style="display: flex; align-items: center; gap: 8px;">
                    <span style="font-size: 0.88rem; font-weight: 600; color: var(--text-secondary);">Qty:</span>
                    <input type="number" value="${escapeHtml(item.quantity)}" min="0.01" step="any" onchange="updateCartQuantity(${htmlArgument(item.productId)}, this.value)" style="width: 80px; padding: 6px 10px; border: 1.5px solid var(--panel-border); border-radius: 8px; font-size: 1.05rem; font-weight: 700; color: var(--text-primary); background: var(--input-bg); outline: none; text-align: center;">
                </div>
                <div style="text-align: right;">
                    <span style="font-size: 0.78rem; color: var(--text-secondary); display: block; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600;">Total</span>
                    <span style="font-weight: 800; font-size: 1.2rem; color: var(--success-color);">₹${itemTotal.toFixed(2)}</span>
                </div>
            </div>
        `;
        cartItemsList.appendChild(card);
    });

    let previousDue = 0;
    if (currentCustomer) {
        previousDue = getCustomerTotalDue(currentCustomer);
    }

    const additionalCostAmountInput = document.getElementById('additionalCostAmount');
    const additionalCost = roundMoney(Number(additionalCostAmountInput?.value) || 0);

    const finalTotal = roundMoney(grandTotal + previousDue + additionalCost);

    if (cartBarTotal) cartBarTotal.textContent = `₹${finalTotal.toFixed(2)}`;
    if (cartBarItemCount) {
        const totalQty = cart.reduce((s, i) => s + i.quantity, 0);
        cartBarItemCount.textContent = `${totalQty} item${totalQty !== 1 ? 's' : ''}`;
    }

    // Keep a hidden element for grand total (used by placeOrder logic)
    let grandTotalElement = document.getElementById('grandTotalValue');
    if (!grandTotalElement) {
        grandTotalElement = document.createElement('span');
        grandTotalElement.id = 'grandTotalValue';
        grandTotalElement.style.display = 'none';
        document.body.appendChild(grandTotalElement);
    }
    grandTotalElement.textContent = `₹${finalTotal.toFixed(2)}`;
    grandTotalElement.dataset.rawTotal = finalTotal;
    grandTotalElement.dataset.previousDue = previousDue;

    updateOrderStepUI();
}


// --- Place Order ---
function placeOrder() {
    orderReviewRevision = cloudRevision;
    if (!currentCustomer) {
        showToast('Please select a customer first.');
        return;
    }
    if (cart.length === 0) {
        showToast('Cart is empty. Please add products before placing an order.');
        return;
    }

    const itemsTotal = getItemsTotal(cart);

    const additionalCostAmountInput = document.getElementById('additionalCostAmount');
    const additionalCost = roundMoney(Number(additionalCostAmountInput?.value) || 0);
    const additionalCostReasonInput = document.getElementById('additionalCostReason');
    const additionalCostReason = additionalCostReasonInput ? additionalCostReasonInput.value.trim() : '';

    if (editingOrderId) {
        const order = orders.find(o => o.id === editingOrderId);
        if (!order) {
            showToast('Error: Bill not found.', 'error');
            return;
        }
        const invoiceNum = getInvoiceNumber(order);
        document.getElementById('confirmCustomerName').textContent = `Editing Bill: ${invoiceNum} (${currentCustomer.name})`;

        let confirmText = `New Items Total: ₹${itemsTotal.toFixed(2)}`;
        if (additionalCost > 0) {
            const reasonDisplay = additionalCostReason ? additionalCostReason : 'Misc';
            confirmText += `<br><span style="font-size:1rem; color:#64748b;">+ ${escapeHtml(reasonDisplay)}: ₹${additionalCost.toFixed(2)}</span>`;
        }

        const originalPreviousDue = order.previousDue || 0;
        if (originalPreviousDue > 0) {
            confirmText += `<br><span style="font-size:1rem; color:var(--danger-color);">+ Original Previous Due: ₹${originalPreviousDue.toFixed(2)}</span>`;
        }

        const newGrandTotal = roundMoney(itemsTotal + originalPreviousDue + additionalCost);


        confirmText += `<br><br>New Grand Total: ₹${newGrandTotal.toFixed(2)}`;

        const diff = newGrandTotal - getOrderTotal(order);
        if (diff !== 0) {
            const diffColor = diff > 0 ? 'var(--danger-color)' : 'var(--success-color)';
            const diffSign = diff > 0 ? '+' : '';
            confirmText += `<br><span style="font-size:1rem; color:${diffColor}; font-weight:600;">Adjustment: ${diffSign}₹${diff.toFixed(2)}</span>`;
        }

        document.getElementById('confirmGrandTotal').innerHTML = confirmText;

        const paymentRecSection = document.querySelector('#confirmOrderModal div[style*="background: rgba(0, 112, 243, 0.05)"]');
        if (paymentRecSection) {
            paymentRecSection.style.display = 'none';
        }

        const prevDueToggle = document.getElementById('includePreviousDueContainer');
        if (prevDueToggle) prevDueToggle.style.display = 'none';

        const saveBtn = document.getElementById('saveAndShareBtn');
        if (saveBtn) {
            saveBtn.innerHTML = '✨ Save Changes & Share';
            saveBtn.setAttribute('onclick', 'finalizeBillEdits()');
        }

        openModal('confirmOrderModal');
        return;
    }

    const prevDueToggle = document.getElementById('includePreviousDueContainer');
    const customerPendingDue = getCustomerTotalDue(currentCustomer);

    if (prevDueToggle) {
        if (customerPendingDue > 0) {
            prevDueToggle.style.display = 'block';
            const amountText = document.getElementById('confirmPrevDueAmountText');
            if (amountText) amountText.textContent = `₹${customerPendingDue.toFixed(2)}`;
        } else {
            prevDueToggle.style.display = 'none';
        }
    }

    const includePrevDueCheckbox = document.getElementById('includePreviousDueCheckbox');
    const shouldIncludePrevDue = (includePrevDueCheckbox && customerPendingDue > 0) ? includePrevDueCheckbox.checked : false;

    const previousDue = shouldIncludePrevDue ? customerPendingDue : 0;

    const grandTotal = roundMoney(itemsTotal + previousDue + additionalCost);

    document.getElementById('confirmCustomerName').textContent = `Customer: ${currentCustomer.name}`;
    let confirmText = `Items Total: ₹${itemsTotal.toFixed(2)}`;
    if (additionalCost > 0) {
        const reasonDisplay = additionalCostReason ? additionalCostReason : 'Misc';
        confirmText += `<br><span style="font-size:1rem; color:#64748b;">+ ${escapeHtml(reasonDisplay)}: ₹${additionalCost.toFixed(2)}</span>`;
    }
    if (previousDue > 0) {
        confirmText += `<br><span style="font-size:1rem; color:var(--danger-color);">+ Previous Due: ₹${previousDue.toFixed(2)}</span>`;
    } else if (customerPendingDue > 0 && !shouldIncludePrevDue) {
        confirmText += `<br><span style="font-size:0.9rem; color:#64748b;">(Pending Dues of ₹${customerPendingDue.toFixed(2)} not added to this bill)</span>`;
    }
    confirmText += `<br><br>Grand Total: ₹${grandTotal.toFixed(2)}`;
    document.getElementById('confirmGrandTotal').innerHTML = confirmText;

    // Reset advance payment fields
    const advanceInput = document.getElementById('advancePaymentAmount');
    if (advanceInput) {
        advanceInput.value = '';
        document.getElementById('advancePaymentMode').value = 'UPI';
        document.getElementById('advancePaymentDate').value = '';
        document.getElementById('advancePaymentReference').value = '';
    }
    document.getElementById('confirmGrandTotal').dataset.originalHtml = confirmText;
    document.getElementById('confirmGrandTotal').dataset.grandTotal = grandTotal;

    openModal('confirmOrderModal');
}

function toggleConfirmPrevDue(isChecked) {
    if (!currentCustomer) return;
    const itemsTotal = getItemsTotal(cart);
    const additionalCostAmountInput = document.getElementById('additionalCostAmount');
    const additionalCost = roundMoney(Number(additionalCostAmountInput?.value) || 0);
    const additionalCostReasonInput = document.getElementById('additionalCostReason');
    const additionalCostReason = additionalCostReasonInput ? additionalCostReasonInput.value.trim() : '';

    const customerPendingDue = getCustomerTotalDue(currentCustomer);
    const previousDue = isChecked ? customerPendingDue : 0;

    const grandTotal = roundMoney(itemsTotal + previousDue + additionalCost);

    let confirmText = `Items Total: ₹${itemsTotal.toFixed(2)}`;
    if (additionalCost > 0) {
        const reasonDisplay = additionalCostReason ? additionalCostReason : 'Misc';
        confirmText += `<br><span style="font-size:1rem; color:#64748b;">+ ${escapeHtml(reasonDisplay)}: ₹${additionalCost.toFixed(2)}</span>`;
    }
    if (previousDue > 0) {
        confirmText += `<br><span style="font-size:1rem; color:var(--danger-color);">+ Previous Due: ₹${previousDue.toFixed(2)}</span>`;
    } else if (customerPendingDue > 0) {
        confirmText += `<br><span style="font-size:0.9rem; color:#64748b;">(Pending Dues of ₹${customerPendingDue.toFixed(2)} not added to this bill)</span>`;
    }
    confirmText += `<br><br>Grand Total: ₹${grandTotal.toFixed(2)}`;

    const confirmGrandTotal = document.getElementById('confirmGrandTotal');
    if (confirmGrandTotal) {
        confirmGrandTotal.dataset.originalHtml = confirmText;
        confirmGrandTotal.dataset.grandTotal = grandTotal;
        updateConfirmTotal();
    }
}

function updateConfirmTotal() {
    const confirmGrandTotal = document.getElementById('confirmGrandTotal');
    if (!confirmGrandTotal) return;
    const originalHtml = confirmGrandTotal.dataset.originalHtml;
    const grandTotal = parseFloat(confirmGrandTotal.dataset.grandTotal || 0);
    const advance = parseFloat(document.getElementById('advancePaymentAmount').value || 0);

    if (advance > 0) {
        const newBalance = grandTotal - advance;
        confirmGrandTotal.innerHTML = originalHtml + `<br><span style="font-size:1.1rem; color:#28a745;">- Payment Received: ₹${advance.toFixed(2)}</span><br><span style="color:#e00;">Final Balance: ₹${newBalance.toFixed(2)}</span>`;
    } else {
        confirmGrandTotal.innerHTML = originalHtml;
    }
}

// --- Finalize Order & Share ---
async function finalizeOrderAndShare() {
    if (!currentCustomer || cart.length === 0) {
        closeModal('confirmOrderModal');
        return;
    }

    const btn = document.getElementById('saveAndShareBtn');
    const originalText = btn ? btn.innerHTML : '✨ Save & Share Bill';
    if (btn) {
        btn.innerHTML = '⏳ Processing...';
        btn.disabled = true;
    }

    try {
        const customer = customers.find(c => c.id === currentCustomer.id);
        if (!customer || orderReviewRevision !== cloudRevision) {
            showToast('Cloud records changed. Review the order again before issuing the invoice.', 'error');
            return;
        }
        currentCustomer = customer;
        const items = cart.map(item => ({ ...item }));
        const itemsTotal = getItemsTotal(items);



        // Check if user chose to include previous dues on this printed bill
        const includePrevDueCheckbox = document.getElementById('includePreviousDueCheckbox');
        const shouldIncludePrevDue = includePrevDueCheckbox ? includePrevDueCheckbox.checked : false;

        // Customer existing pending dues across all previous orders
        const existingDues = getCustomerTotalDue(customer);
        const previousDue = shouldIncludePrevDue ? existingDues : 0;

        const additionalCostAmountInput = document.getElementById('additionalCostAmount');
        const additionalCost = roundMoney(Number(additionalCostAmountInput?.value) || 0);
        const additionalCostReasonInput = document.getElementById('additionalCostReason');
        const additionalCostReason = additionalCostReasonInput ? additionalCostReasonInput.value.trim() : '';

        const grandTotal = roundMoney(itemsTotal + previousDue + additionalCost);

        const advancePaymentInput = document.getElementById('advancePaymentAmount');
        const advanceModeInput = document.getElementById('advancePaymentMode');
        let advanceAmount = 0;
        if (advancePaymentInput) {
            advanceAmount = parseFloat(advancePaymentInput.value || 0);
            if (isNaN(advanceAmount) || advanceAmount < 0) advanceAmount = 0;
        }

        if (advanceAmount > roundMoney(grandTotal)) {
            showToast('Payment received cannot be greater than the grand total.', 'error');
            return;
        }

        const advanceDate = readPaymentDate('advancePaymentDate');
        const advanceReference = document.getElementById('advancePaymentReference').value.trim();
        const advanceMode = advanceModeInput ? advanceModeInput.value : 'UPI';
        if (advanceAmount && (!advanceDate || hasPaymentReference(customer.id, advanceMode, advanceReference))) {
            showToast('Check the payment date and make sure the reference has not already been recorded.', 'error');
            return;
        }

        if (!signedIn || cloudRevision === null || cloudLoad || cloudWrite) {
            showToast('Wait for the cloud connection before issuing an invoice.', 'error');
            return;
        }
        const draftRevision = cloudRevision;
        const { data: invoiceNumber, error } = await supabaseClient.rpc('taruchhaya_invoice_number');
        if (error) throw error;
        if (draftRevision !== cloudRevision) {
            showToast('Records changed while you were preparing this bill. Review the amount and try again.', 'error');
            return;
        }
        const newOrderId = 'ord_v2_' + invoiceNumber;
        const carriedOrders = shouldIncludePrevDue ? getPayableOrders(customer)
            .map(order => ({ ...order, adjustedWithOrderId: newOrderId })) : [];

        const newOrder = {
            id: newOrderId,
            customerId: customer.id,
            customerName: customer.name,
            customerPhone: customer.phone || '',
            customerAddress: customer.address || '',
            items,
            itemsTotal: itemsTotal,
            previousDue: previousDue,
            additionalCost: additionalCost,
            additionalCostReason: additionalCostReason,
            totalAmount: grandTotal,
            paidAmount: advanceAmount,
            date: new Date().toISOString()
        };

        const payment = advanceAmount > 0 ? makePaymentRecord(customer, advanceAmount, advanceMode, advanceDate, {
            kind: 'receipt', reference: advanceReference,
            allocations: [{ orderId: newOrderId, amount: advanceAmount }], credit: 0
        }) : null;
        if (!await saveCloudChanges({ new_order: newOrderId, orders: [newOrder, ...carriedOrders].map(orderCloudRow),
            payment: payment && paymentCloudRow(payment) })) return;

        // Build shareable bill HTML
        const invoiceNum = getInvoiceNumber(newOrder);
        const billElement = buildBillHTML(customer.name, customer.address, items, grandTotal, previousDue, advanceAmount, additionalCost, additionalCostReason, invoiceNum, false, newOrder.date);

        // Reset inputs
        if (additionalCostAmountInput) additionalCostAmountInput.value = '';
        if (additionalCostReasonInput) additionalCostReasonInput.value = '';

        // Share or copy as image
        await shareAsImage(billElement, `Bill for ${customer.name}`);

        // Reset UI
        cart = [];
        currentCustomer = null;

        const custSelect = document.getElementById('customerSelect');
        if (custSelect) custSelect.value = '';

        const customerSearch = document.getElementById('customerSearch');
        if (customerSearch) customerSearch.value = '';

        updateOrderStepUI();
        renderCart();
        renderBills();
        renderCustomersList();
        renderHomeDashboard();

        closeModal('confirmOrderModal');
    } catch (err) {
        console.error('Error finalizing order:', err);
        showToast('Error saving order: ' + (err.message || err), 'error');
    } finally {
        if (btn) {
            btn.innerHTML = originalText;
            btn.disabled = false;
        }
    }
}

// --- Edit Bill Logic ---

function startEditBill(orderId) {
    const order = orders.find(o => o.id === orderId);
    if (!order) {
        showToast('Bill not found.', 'error');
        return;
    }

    editingOrderId = orderId;
    editingOrderSnapshot = JSON.stringify(order);
    currentCustomer = customers.find(c => orderBelongsToCustomer(order, c));

    if (!currentCustomer) {
        // Fallback if customer was deleted but we have snapshotted name
        currentCustomer = { id: order.customerId, name: order.customerName || 'Unknown Customer', phone: order.customerPhone || '' };
    }

    // Load items into cart
    cart = JSON.parse(JSON.stringify(order.items || []));

    // Set additional cost
    const additionalCostAmountInput = document.getElementById('additionalCostAmount');
    if (additionalCostAmountInput) {
        additionalCostAmountInput.value = order.additionalCost || '';
    }
    const additionalCostReasonInput = document.getElementById('additionalCostReason');
    if (additionalCostReasonInput) {
        additionalCostReasonInput.value = order.additionalCostReason || '';
    }

    // Show banner
    const banner = document.getElementById('editBillBanner');
    if (banner) {
        banner.style.display = 'flex';
        document.getElementById('editBillInvoiceNum').textContent = getInvoiceNumber(order);
    }

    // Set customer selection dropdown value & input
    const custSelect = document.getElementById('customerSelect');
    if (custSelect) {
        if (!customers.some(c => c.id === currentCustomer.id)) {
            const opt = document.createElement('option');
            opt.value = currentCustomer.id;
            opt.textContent = currentCustomer.name;
            custSelect.appendChild(opt);
        }
        custSelect.value = currentCustomer.id;
    }

    const customerSearch = document.getElementById('customerSearch');
    if (customerSearch) {
        customerSearch.value = currentCustomer.name;
    }

    // Switch to order view
    switchView('mainView');

    // Re-render cart and update steps
    updateOrderStepUI();
    renderCart();

    // Change Place Order button label
    const placeOrderBtn = document.getElementById('placeOrderBtn');
    if (placeOrderBtn) {
        placeOrderBtn.innerHTML = 'Review Changes →';
    }
}

function cancelEditBill() {
    editingOrderId = null;
    currentCustomer = null;
    cart = [];

    // Reset fields
    const additionalCostAmountInput = document.getElementById('additionalCostAmount');
    if (additionalCostAmountInput) additionalCostAmountInput.value = '';
    const additionalCostReasonInput = document.getElementById('additionalCostReason');
    if (additionalCostReasonInput) additionalCostReasonInput.value = '';

    const custSelect = document.getElementById('customerSelect');
    if (custSelect) custSelect.value = '';

    const customerSearch = document.getElementById('customerSearch');
    if (customerSearch) customerSearch.value = '';

    // Hide banner
    const banner = document.getElementById('editBillBanner');
    if (banner) banner.style.display = 'none';

    // Reset headers/buttons
    const placeOrderBtn = document.getElementById('placeOrderBtn');
    if (placeOrderBtn) placeOrderBtn.innerHTML = 'Place Order →';

    updateOrderStepUI();
    renderCart();
    switchView('billsView');
}

function planCarryChange(order, dueChange, projected = new Map()) {
    const changes = [];
    const visited = new Set([order.id]);
    while (dueChange && order.adjustedWithOrderId) {
        const next = orders.find(o => o.id === order.adjustedWithOrderId);
        if (!next || visited.has(next.id)) return null;
        visited.add(next.id);
        const current = projected.get(next.id) || next;
        const previousDue = roundMoney((Number(current.previousDue) || 0) + dueChange);
        const totalAmount = roundMoney(Number(current.totalAmount ?? getOrderTotal(next)) + dueChange);
        if (previousDue < 0 || totalAmount < getOrderPaid(next)) return null;
        const change = { order: next, previousDue, totalAmount };
        changes.push(change);
        projected.set(next.id, change);
        order = next;
    }
    return changes;
}

function ordersWithCarryChanges(changes) {
    return changes.map(({ order, previousDue, totalAmount }) => ({ ...order, previousDue, totalAmount }));
}

async function finalizeBillEdits() {
    if (!editingOrderId) return;

    const btn = document.getElementById('saveAndShareBtn');
    const originalText = btn ? btn.innerHTML : '✨ Save Changes & Share';
    if (btn) {
        btn.innerHTML = '⏳ Saving...';
        btn.disabled = true;
    }

    try {


        const order = orders.find(o => o.id === editingOrderId);
        if (order && (JSON.stringify(order) !== editingOrderSnapshot || orderReviewRevision !== cloudRevision)) {
            showToast('Cloud records changed. Reopen this bill before saving edits.', 'error');
            return;
        }
        if (!order) {
            closeModal('confirmOrderModal');
            showToast('Error: Bill not found.', 'error');
            return;
        }

        const itemsTotal = getItemsTotal(cart);
        const additionalCostAmountInput = document.getElementById('additionalCostAmount');
        const additionalCost = roundMoney(Number(additionalCostAmountInput?.value) || 0);
        const additionalCostReasonInput = document.getElementById('additionalCostReason');
        const additionalCostReason = additionalCostReasonInput ? additionalCostReasonInput.value.trim() : '';

        const newGrandTotal = roundMoney(itemsTotal + (order.previousDue || 0) + additionalCost);
        const paid = getOrderPaid(order);
        const carryChanges = planCarryChange(order, roundMoney(newGrandTotal - paid - getOrderDue(order)));
        if (newGrandTotal < paid || !carryChanges) {
            showToast('This edit would conflict with recorded payments or carried balances. Review those records first.', 'error');
            return;
        }

        const updated = { ...order, items: [...cart], itemsTotal, additionalCost, additionalCostReason, totalAmount: newGrandTotal };
        if (!await saveCloudChanges({ orders: [updated, ...ordersWithCarryChanges(carryChanges)].map(orderCloudRow) })) return;

        // Build shareable bill HTML
        const invoiceNum = getInvoiceNumber(order);
        const billElement = buildBillHTML(
            updated.customerName,
            updated.customerAddress,
            updated.items,
            newGrandTotal,
            order.previousDue || 0,
            order.paidAmount || 0,
            additionalCost,
            additionalCostReason,
            invoiceNum,
            isOrderAdjusted(order),
            order.date
        );

        // Reset inputs
        if (additionalCostAmountInput) additionalCostAmountInput.value = '';
        if (additionalCostReasonInput) additionalCostReasonInput.value = '';

        // Share or copy as image
        await shareAsImage(billElement, `Updated Bill for ${currentCustomer.name}`);

        // Reset editing state
        editingOrderId = null;
        cart = [];
        currentCustomer = null;

        const custSelect = document.getElementById('customerSelect');
        if (custSelect) custSelect.value = '';

        const customerSearch = document.getElementById('customerSearch');
        if (customerSearch) customerSearch.value = '';

        // Hide banner
        const banner = document.getElementById('editBillBanner');
        if (banner) banner.style.display = 'none';

        // Reset place order button
        const placeOrderBtn = document.getElementById('placeOrderBtn');
        if (placeOrderBtn) placeOrderBtn.innerHTML = 'Place Order →';

        // Show advance payment inputs in confirmation modal again for future new orders
        const paymentRecSection = document.querySelector('#confirmOrderModal div[style*="background: rgba(0, 112, 243, 0.05)"]');
        if (paymentRecSection) {
            paymentRecSection.style.display = 'block';
        }

        const prevDueToggle = document.getElementById('includePreviousDueContainer');
        if (prevDueToggle) prevDueToggle.style.display = 'block';

        // Reset save button onclick and text
        const saveBtn = document.getElementById('saveAndShareBtn');
        if (saveBtn) {
            saveBtn.innerHTML = '✨ Save & Share Bill';
            saveBtn.setAttribute('onclick', 'finalizeOrderAndShare()');
        }

        updateOrderStepUI();
        renderCart();
        renderBills();
        renderCustomersList();
        renderHomeDashboard();

        closeModal('confirmOrderModal');

        // Switch view back to bills view
        switchView('billsView');

        showToast('Bill updated successfully!', 'success');
    } catch (err) {
        console.error('Error saving bill edits:', err);
        showToast('Error updating bill: ' + (err.message || err), 'error');
    } finally {
        if (btn) {
            btn.innerHTML = originalText;
            btn.disabled = false;
        }
    }
}

// --- Utility: Build bill HTML ---
function buildBillHTML(customerName, customerAddress, items, grandTotal, previousDue = 0, advanceAmount = 0, additionalCost = 0, additionalCostReason = '', invoiceNum = '', carriedForward = false, issuedAt) {
    const now = new Date(issuedAt);
    const validDate = Number.isFinite(now.getTime());
    const date = validDate ? now.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Kolkata' }) : 'Unavailable';
    const time = validDate ? now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }) : '';

    const container = document.createElement('div');
    container.style.width = '800px';
    container.style.padding = '40px';
    container.style.backgroundColor = '#ffffff';
    container.style.fontFamily = "'Inter', sans-serif";
    container.style.color = '#1e293b';
    container.style.boxSizing = 'border-box';

    let html = `
        <div style="display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #e2e8f0; padding-bottom: 20px; margin-bottom: 20px;">
            <div>
                <h1 style="margin: 0; font-size: 28px; color: #2563eb; font-weight: 700;">Taruchhaya Enterprise</h1>
                <p style="margin: 5px 0 0 0; color: #64748b; font-size: 14px;">Hat-Tola Road, Pandui, Puncha, Purulia - 723151</p>
            </div>
            <div style="text-align: right;">
                <h2 style="margin: 0; font-size: 24px; color: #334155;">INVOICE</h2>
                ${invoiceNum ? `<p style="margin: 5px 0 0 0; color: #64748b; font-size: 14px;">Invoice No: <strong>${escapeHtml(invoiceNum)}</strong></p>` : ''}
                <p style="margin: ${invoiceNum ? '3px' : '5px'} 0 0 0; color: #64748b; font-size: 14px;">Date: <strong>${date} ${time}</strong></p>
            </div>
        </div>
        
        <div style="margin-bottom: 30px;">
            <p style="margin: 0; font-size: 14px; color: #64748b;">Billed To:</p>
            <h3 style="margin: 5px 0 0 0; font-size: 18px; color: #1e293b;">${escapeHtml(customerName)}</h3>
            ${customerAddress ? `<p style="margin: 3px 0 0 0; font-size: 14px; color: #64748b; white-space: pre-wrap;">${escapeHtml(customerAddress)}</p>` : ''}
        </div>
        
        <table style="width: 100%; border-collapse: collapse; margin-bottom: 30px;">
            <thead>
                <tr style="background-color: #f8fafc; border-bottom: 2px solid #e2e8f0;">
                    <th style="padding: 12px; text-align: left; font-size: 14px; color: #475569;">#</th>
                    <th style="padding: 12px; text-align: left; font-size: 14px; color: #475569;">Item</th>
                    <th style="padding: 12px; text-align: center; font-size: 14px; color: #475569;">Qty</th>
                    <th style="padding: 12px; text-align: right; font-size: 14px; color: #475569;">Rate (Incl. Taxes)</th>
                    <th style="padding: 12px; text-align: right; font-size: 14px; color: #475569;">Amount</th>
                </tr>
            </thead>
            <tbody>
    `;

    let subTotal = 0;
    items.forEach((item, index) => {
        const itemAmount = getLineTotal(item);
        subTotal += itemAmount;
        let amountStr = itemAmount.toFixed(2);
        html += `
            <tr style="border-bottom: 1px solid #f1f5f9;">
                <td style="padding: 12px; font-size: 14px; color: #334155;">${index + 1}</td>
                <td style="padding: 12px; font-size: 14px; color: #334155; font-weight: 500;">${escapeHtml(item.name)}</td>
                <td style="padding: 12px; text-align: center; font-size: 14px; color: #334155;">${escapeHtml(item.quantity)}</td>
                <td style="padding: 12px; text-align: right; font-size: 14px; color: #334155;">₹${item.price.toFixed(2)}</td>
                <td style="padding: 12px; text-align: right; font-size: 14px; color: #334155;">₹${amountStr}</td>
            </tr>
        `;
    });

    const rawTotal = subTotal + previousDue + additionalCost;
    const roundOff = grandTotal - rawTotal;

    html += `
            </tbody>
        </table>
        
        <div style="display: flex; justify-content: flex-end;">
            <div style="width: 350px;">
                <div style="display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #f1f5f9;">
                    <span style="color: #64748b; font-size: 14px;">Sub Total</span>
                    <span style="color: #334155; font-size: 14px; font-weight: 500;">₹${subTotal.toFixed(2)}</span>
                </div>
    `;

    if (additionalCost > 0) {
        let reason = additionalCostReason || 'Misc. Cost';
        html += `
                <div style="display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #f1f5f9;">
                    <span style="color: #64748b; font-size: 14px;">${escapeHtml(reason)}</span>
                    <span style="color: #334155; font-size: 14px; font-weight: 500;">₹${additionalCost.toFixed(2)}</span>
                </div>
        `;
    }

    if (previousDue > 0) {
        html += `
                <div style="display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #f1f5f9;">
                    <span style="color: #64748b; font-size: 14px;">Previous Due</span>
                    <span style="color: #334155; font-size: 14px; font-weight: 500;">₹${previousDue.toFixed(2)}</span>
                </div>
        `;
    }

    if (Math.abs(roundOff) > 0.001) {
        html += `
                <div style="display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #f1f5f9;">
                    <span style="color: #64748b; font-size: 14px;">Round Off</span>
                    <span style="color: #334155; font-size: 14px; font-weight: 500;">₹${roundOff > 0 ? '+' : ''}${roundOff.toFixed(2)}</span>
                </div>
        `;
    }

    html += `
                <div style="display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #f1f5f9;">
                    <span style="color: #334155; font-size: 15px; font-weight: 600;">Total</span>
                    <span style="color: #334155; font-size: 15px; font-weight: 600;">₹${grandTotal.toFixed(2)}</span>
                </div>
    `;

    if (advanceAmount > 0) {
        html += `
                <div style="display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #f1f5f9;">
                    <span style="color: #10b981; font-size: 14px;">Payment Received</span>
                    <span style="color: #10b981; font-size: 14px; font-weight: 500;">-₹${advanceAmount.toFixed(2)}</span>
                </div>
        `;
    }

    const balanceDue = grandTotal - advanceAmount;

    html += `
                <div style="display: flex; justify-content: space-between; padding: 12px 0; border-top: 2px solid #e2e8f0; margin-top: 8px;">
                    <span style="color: #0f172a; font-size: 18px; font-weight: 700;">${carriedForward ? 'Balance carried forward' : 'Balance Due'}</span>
                    <span style="color: #ef4444; font-size: 18px; font-weight: 700;">₹${balanceDue.toFixed(2)}</span>
                </div>
            </div>
        </div>
        
        <div style="margin-top: 40px; text-align: center; border-top: 2px solid #e2e8f0; padding-top: 20px;">
            <p style="margin: 0; font-size: 16px; color: #334155; font-weight: 500;">Thanks for your business.</p>
            <p style="margin: 8px 0 0 0; font-size: 12px; color: #94a3b8;">Generated under Taruchhaya Systems</p>
            <p style="margin: 2px 0 0 0; font-size: 12px; color: #94a3b8;">via Taruchhaya Invoice</p>
        </div>
    `;

    container.innerHTML = html;
    return container;
}

// --- Utility: Share HTML as Image ---
async function invoiceImage(element) {
    if (!window.html2canvas) throw new Error('The invoice image library could not load.');
    Object.assign(element.style, { position: 'absolute', left: '-9999px', top: '0' });
    document.body.appendChild(element);
    try {
        const canvas = await html2canvas(element, { scale: 2, backgroundColor: '#ffffff' });
        return await new Promise((resolve, reject) => canvas.toBlob(
            blob => blob ? resolve(blob) : reject(new Error('The invoice image could not be generated.')), 'image/png'));
    } finally {
        element.remove();
    }
}

function downloadFile(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function shareAsImage(element, title, downloadOnly = false) {
    try {
        const blob = await invoiceImage(element);
        const file = new File([blob], 'invoice.png', { type: 'image/png' });
        if (!downloadOnly && navigator.share && navigator.canShare?.({ files: [file] })) {
            try {
                await navigator.share({ title, files: [file] });
                return;
            } catch (err) {
                if (err.name === 'AbortError') {
                    showToast('Sharing canceled. You can download the invoice from its preview.');
                    return;
                }
            }
        }
        downloadFile(file, file.name);
        showToast('Invoice image downloaded.');
    } catch (err) {
        showToast(err.message || 'Invoice image unavailable. Try Print Invoice.', 'error');
    }
}

// --- Payments Logic ---
function handlePaymentCustomerChange() {
    return onPaymentCustomerChange();
}

function onPaymentCustomerChange() {
    paymentReviewRevision = cloudRevision;
    const custSelect = document.getElementById('paymentCustomerSelect');
    const amountInput = document.getElementById('paymentAmount');
    const invoiceGroup = document.getElementById('paymentInvoiceGroup');
    const dateGroup = document.getElementById('paymentDateGroup');
    const invoiceIdInput = document.getElementById('paymentDisplayInvoiceId');
    const dateInput = document.getElementById('paymentInvoiceDate');
    updatePaymentCredit();
    const billInput = document.getElementById('paymentBillId');

    if (billInput) billInput.value = '';

    if (!custSelect) return;

    if (custSelect.value === 'add_new') {
        openModal('customerModal');
        custSelect.value = '';
        if (amountInput) amountInput.value = '';
        if (invoiceGroup) invoiceGroup.style.display = 'none';
        if (dateGroup) dateGroup.style.display = 'none';
        return;
    }

    if (!custSelect.value) {
        if (amountInput) amountInput.value = '';
        if (invoiceGroup) invoiceGroup.style.display = 'none';
        if (dateGroup) dateGroup.style.display = 'none';
        return;
    }

    const customerId = custSelect.value;
    const targetCust = customers.find(c => String(c.id) === customerId);
    const unpaidOrders = getPayableOrders(targetCust);
    const totalDue = getCustomerTotalDue(targetCust);

    if (amountInput) amountInput.value = totalDue > 0 ? totalDue.toFixed(2) : '';

    if (unpaidOrders.length > 0) {
        if (invoiceIdInput) invoiceIdInput.value = unpaidOrders.map(o => getInvoiceNumber(o)).join(', ');
        if (dateInput) dateInput.value = unpaidOrders.map(o => new Date(o.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })).join(', ');
        if (invoiceGroup) invoiceGroup.style.display = 'block';
        if (dateGroup) dateGroup.style.display = 'block';
    } else {
        if (invoiceGroup) invoiceGroup.style.display = 'none';
        if (dateGroup) dateGroup.style.display = 'none';
    }
}

function openPaymentModal(orderId = null) {
    paymentReviewRevision = cloudRevision;
    const custSelect = document.getElementById('paymentCustomerSelect');
    const billInput = document.getElementById('paymentBillId');
    const invoiceGroup = document.getElementById('paymentInvoiceGroup');
    const dateGroup = document.getElementById('paymentDateGroup');
    const invoiceIdInput = document.getElementById('paymentDisplayInvoiceId');
    const dateInput = document.getElementById('paymentInvoiceDate');
    const amountInput = document.getElementById('paymentAmount');

    custSelect.innerHTML = '<option value="">-- Select Customer --</option>';
    customers.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.id;
        const duplicateName = customers.some(other => other !== c && other.name.trim().toLowerCase() === c.name.trim().toLowerCase());
        opt.textContent = duplicateName
            ? [c.name, c.phone, c.address, c.id].filter(Boolean).join(' · ')
            : c.name;
        custSelect.appendChild(opt);
    });

    const addNewOption = document.createElement('option');
    addNewOption.value = 'add_new';
    addNewOption.textContent = '+ Add New Customer';
    addNewOption.style.fontWeight = 'bold';
    custSelect.appendChild(addNewOption);

    const order = orders.find(o => o.id === orderId);
    const customer = order && customers.find(c => orderBelongsToCustomer(order, c));
    if (orderId && (!order || !customer || isOrderAdjusted(order) || getOrderDue(order) <= 0)) {
        showToast('Select an outstanding bill with an active customer.', 'error');
        return;
    }

    if (order) {
        custSelect.value = customer.id;
        custSelect.disabled = true;
        if (billInput) billInput.value = order.id;

        if (invoiceIdInput) invoiceIdInput.value = getInvoiceNumber(order);
        if (dateInput) dateInput.value = new Date(order.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
        if (invoiceGroup) invoiceGroup.style.display = 'block';
        if (dateGroup) dateGroup.style.display = 'block';

        const pending = getOrderDue(order);
        if (amountInput) amountInput.value = pending.toFixed(2);
    } else {
        custSelect.disabled = false;
        custSelect.value = '';
        if (billInput) billInput.value = '';
        if (invoiceGroup) invoiceGroup.style.display = 'none';
        if (dateGroup) dateGroup.style.display = 'none';
        if (amountInput) amountInput.value = '';
    }

    document.getElementById('paymentReceivedDate').value = '';
    document.getElementById('paymentReference').value = '';
    document.getElementById('paymentMode').value = 'Cash';
    updatePaymentCredit();
    openModal('paymentModal');
}

function readPaymentDate(inputId) {
    const input = document.getElementById(inputId);
    const date = input?.value ? new Date(input.value) : new Date();
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function getPaymentReversal(paymentId) {
    return paymentHistory.find(p => p.details?.reverses === paymentId);
}

function getCustomerCredit(customerId) {
    return roundMoney(paymentHistory.reduce((balance, payment) => {
        if (String(payment.customerId) !== String(customerId)) return balance;
        return balance + (payment.details?.credit || 0);
    }, 0));
}

function hasPaymentReference(customerId, mode, reference) {
    return !!reference && paymentHistory.some(payment => String(payment.customerId) === String(customerId) &&
        payment.mode === mode && payment.details?.kind === 'receipt' &&
        payment.details.reference?.toLowerCase() === reference.toLowerCase() && !getPaymentReversal(payment.id));
}

function updatePaymentCredit() {
    const customerId = document.getElementById('paymentCustomerSelect').value;
    const credit = getCustomerCredit(customerId);
    document.getElementById('paymentCreditBalance').textContent = credit > 0
        ? 'Available customer credit: ₹' + credit.toFixed(2) : '';
    document.getElementById('applyPaymentCredit').hidden = credit <= 0;
}

function makePaymentRecord(customer, amount, mode, date, details) {
    return {
        id: 'pay_' + (globalThis.crypto?.randomUUID?.() || Date.now() + '_' + Math.random().toString(36).slice(2)),
        customerId: customer.id,
        customerName: customer.name,
        amount,
        mode,
        date,
        details
    };
}

function refreshPaymentViews() {
    renderBills();
    renderPaymentHistory();
    renderCustomersList();
    renderHomeDashboard();
    updateOrderStepUI();
    if (document.getElementById('unpaidModal')?.classList.contains('active')) showUnpaidModal();
}

async function savePayment(e, useCredit = false) {
    e.preventDefault();
    if (paymentReviewRevision !== cloudRevision) {
        showToast('Cloud records changed. Reopen Record Payment to check the latest balance.', 'error');
        return;
    }
    const customerId = document.getElementById('paymentCustomerSelect').value;
    const orderId = document.getElementById('paymentBillId').value;
    const amount = roundMoney(Number(document.getElementById('paymentAmount').value));
    const mode = document.getElementById('paymentMode').value;
    const date = readPaymentDate('paymentReceivedDate');
    const reference = useCredit ? '' : document.getElementById('paymentReference').value.trim();
    const customer = customers.find(c => String(c.id) === customerId);
    if (!customer || !Number.isFinite(amount) || amount <= 0 || !date) {
        showToast('Select a customer and enter a valid amount and payment date.', 'error');
        return;
    }
    if (hasPaymentReference(customerId, mode, reference)) {
        showToast('This payment reference has already been recorded for this customer.', 'error');
        return;
    }

    const payable = getPayableOrders(customer);
    const targets = orderId ? payable.filter(order => order.id === orderId) : payable;
    if (orderId && !targets.length) {
        showToast('This bill is no longer payable. Reopen the payment form and check the balance.', 'error');
        return;
    }

    const totalDue = roundMoney(targets.reduce((sum, order) => sum + getOrderDue(order), 0));
    if (useCredit && (amount > getCustomerCredit(customerId) || amount > totalDue)) {
        showToast('Enter an amount within both the available credit and the outstanding balance.', 'error');
        return;
    }

    let remaining = amount;
    const allocations = [];
    const changedOrders = [];
    for (const order of targets) {
        if (remaining <= 0) break;
        const applied = Math.min(getOrderDue(order), remaining);
        const paidAmount = roundMoney(getOrderPaid(order) + applied);
        remaining = roundMoney(remaining - applied);
        allocations.push({ orderId: order.id, amount: applied });
        changedOrders.push({ ...order, paidAmount, totalAmount: getOrderTotal(order) });
    }

    const payment = makePaymentRecord(customer, amount, useCredit ? 'Customer Credit' : mode, date, {
        kind: useCredit ? 'credit' : 'receipt',
        reference,
        allocations,
        credit: useCredit ? -amount : remaining
    });
    if (!await saveCloudChanges({ orders: changedOrders.map(orderCloudRow), payment: paymentCloudRow(payment) })) return;
    closeModal('paymentModal');
    refreshPaymentViews();
    showToast(useCredit ? 'Customer credit applied.' : remaining > 0
        ? 'Payment recorded. ₹' + remaining.toFixed(2) + ' is available as customer credit.'
        : 'Payment recorded successfully.');
}

async function reversePayment(paymentId) {
    const payment = paymentHistory.find(p => p.id === paymentId);
    const details = payment?.details;
    if (!Array.isArray(details?.allocations) || !['receipt', 'credit'].includes(details.kind)) return;
    const reason = document.getElementById('paymentReversalReason').value.trim();
    if (!reason) {
        showToast('Enter a reason for the reversal.', 'error');
        return;
    }
    if (!await showCustomConfirm('Reverse this entry and update the affected invoice balances?')) return;
    if (!paymentHistory.includes(payment) || getPaymentReversal(paymentId)) {
        showToast('This payment changed. Reopen it from Payment History.', 'error');
        return;
    }
    if (details.credit > 0 && getCustomerCredit(payment.customerId) < details.credit) {
        showToast('Reverse enough credit applications for this customer before reversing this receipt.', 'error');
        return;
    }

    const direct = [];
    const projected = new Map();
    for (const allocation of details.allocations) {
        const order = orders.find(o => o.id === allocation.orderId);
        const paid = getOrderPaid(order);
        if (!order || paid < allocation.amount) {
            showToast('A linked invoice is missing or its paid amount has changed. Review its records first.', 'error');
            return;
        }
        const paidAmount = roundMoney(paid - allocation.amount);
        const dueChange = roundMoney(Math.max(0, getOrderTotal(order) - paidAmount) - getOrderDue(order));
        if (!planCarryChange(order, dueChange, projected)) {
            showToast('A carried balance could not be updated safely. Review the linked bills first.', 'error');
            return;
        }
        direct.push({ order, paidAmount });
    }

    const changedOrders = new Map(ordersWithCarryChanges([...projected.values()]).map(order => [order.id, order]));
    for (const { order, paidAmount } of direct) {
        changedOrders.set(order.id, { ...(changedOrders.get(order.id) || order), paidAmount });
    }
    const reversal = makePaymentRecord({ id: payment.customerId, name: payment.customerName }, payment.amount,
        payment.mode, new Date().toISOString(), {
            kind: 'reversal', reverses: paymentId, reason, allocations: details.allocations, credit: -details.credit
        });
    if (!await saveCloudChanges({ orders: [...changedOrders.values()].map(orderCloudRow), payment: paymentCloudRow(reversal) })) return;

    closeModal('paymentDetailsModal');
    refreshPaymentViews();
    showToast('Payment reversed. Record a new payment if a correction is needed.');
}

// --- Customers View Management ---
function renderCustomersList() {
    const container = document.getElementById('customersListContainer');
    if (!container) return;
    container.innerHTML = '';

    if (customers.length === 0) {
        container.innerHTML = '<p style="text-align:center; color:var(--text-secondary); margin-top:20px; font-style:italic;">No customers found.</p>';
        return;
    }

    const searchInput = document.getElementById('customerListSearchInput');
    const query = searchInput ? searchInput.value.trim().toLowerCase() : '';

    let sortedCustomers = [...customers].sort((a, b) => a.name.localeCompare(b.name));
    if (query) {
        sortedCustomers = sortedCustomers.filter(c => 
            (c.name || '').toLowerCase().includes(query) || 
            (c.phone || '').toLowerCase().includes(query) || 
            (c.address || '').toLowerCase().includes(query)
        );
    }

    if (sortedCustomers.length === 0) {
        container.innerHTML = `<p style="text-align:center; color:var(--text-secondary); margin-top:20px; font-style:italic;">No customers matching "${escapeHtml(query)}".</p>`;
        return;
    }

    sortedCustomers.forEach(cust => {
        const totalDue = getCustomerTotalDue(cust);

        const d = new Date(cust.createdAt || Date.now());
        const dateString = d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

        const card = document.createElement('div');
        card.className = 'bill-card';
        card.style.marginBottom = '15px';
        card.style.display = 'flex';
        card.style.flexDirection = 'column';
        card.style.gap = '10px';

        card.innerHTML = `
            <div>
                <h3 style="margin: 0; font-size: 1.25rem; font-weight: 700; color: #1e293b;">${escapeHtml(cust.name)}</h3>
                <div style="margin-top: 4px; display: flex; flex-direction: column; gap: 2px;">
                    <span style="font-size: 0.9rem; color: #64748b;">📞 ${escapeHtml(cust.phone || 'N/A')}</span>
                    <span style="font-size: 0.9rem; color: #64748b;">Added: ${dateString}</span>
                </div>
            </div>
            
            <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; margin-top: 5px;">
                <span style="color: ${totalDue > 0 ? 'var(--danger-color)' : 'var(--success-color)'}; font-weight: 700; font-size: 1.1rem; flex: 1;">
                    ${totalDue > 0 ? 'Due: ₹' + totalDue.toFixed(2) : 'No Dues'}
                </span>
                
                <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
                    ${totalDue > 0 ? `<button class="btn btn-secondary" style="padding: 4px 10px; font-size: 0.85rem; border-color: var(--success-color); color: var(--success-color); background: transparent; border-radius: 8px; font-weight: 600;" onclick="openPaymentForCustomer(${htmlArgument(cust.id)})">💰 Pay</button>` : ''}
                    <button class="btn btn-secondary" style="padding: 4px 12px; font-size: 0.9rem; border-color: var(--accent-color); color: var(--accent-color); background: transparent; border-radius: 8px; display: flex; align-items: center; gap: 4px;" onclick="editCustomer(${htmlArgument(cust.id)})">✏️ Edit</button>
                    <button class="btn-danger" style="padding: 4px 8px; font-size: 0.9rem; border: none; background: transparent; display: flex; align-items: center; gap: 4px; cursor: pointer; color: var(--danger-color);" onclick="deleteCustomer(${htmlArgument(cust.id)})">🗑️ Delete</button>
                </div>
            </div>
            
            <div style="margin-top: 5px;">
                <button class="btn btn-secondary" style="padding: 6px 16px; font-size: 0.95rem; border-color: var(--accent-color); color: var(--accent-color); background: transparent; border-radius: 8px;" onclick="viewCustomerBills(${htmlArgument(cust.id)})">View Bills</button>
            </div>
        `;
        container.appendChild(card);
    });
}

function openPaymentForCustomer(customerId) {
    openPaymentModal();
    const custSelect = document.getElementById('paymentCustomerSelect');
    if (custSelect) {
        custSelect.value = customerId;
        onPaymentCustomerChange();
    }
}

function viewCustomerBills(customerId) {
    billsCustomerId = customerId;
    document.getElementById('billSearchInput').value = '';
    switchView('billsView');
}

function clearBillsCustomerFilter() {
    billsCustomerId = null;
    renderBills();
}

// --- Dashboard Management ---

function outstandingByDate(order, carriedByTarget, visiting = new Set()) {
    if (visiting.has(order.id)) return [];
    visiting.add(order.id);
    const linked = (carriedByTarget.get(order.id) || [])
        .flatMap(source => outstandingByDate(source, carriedByTarget, visiting))
        .sort((a, b) => (a.date ?? -Infinity) - (b.date ?? -Infinity));
    visiting.delete(order.id);

    const total = getOrderTotal(order);
    let carried = Math.min(total, Math.max(0, Number(order.previousDue) || 0));
    const current = roundMoney(total - carried);
    const charges = [];
    for (const entry of linked) {
        const amount = Math.min(carried, entry.amount);
        if (amount > 0) charges.push({ date: entry.date, amount });
        carried = roundMoney(carried - amount);
    }
    if (carried > 0) charges.unshift({ date: null, amount: carried });
    const issuedAt = Date.parse(order.date);
    if (current > 0) charges.push({ date: Number.isFinite(issuedAt) ? issuedAt : null, amount: current });

    let paid = getOrderPaid(order);
    return charges.flatMap(charge => {
        const applied = Math.min(paid, charge.amount);
        paid = roundMoney(paid - applied);
        const amount = roundMoney(charge.amount - applied);
        return amount > 0 ? [{ ...charge, amount }] : [];
    });
}

const reportingMonth = new Intl.DateTimeFormat('en-IN', {
    year: 'numeric', month: '2-digit', timeZone: 'Asia/Kolkata'
});

function isInReportingMonth(date, now) {
    return Number.isFinite(date.getTime()) && reportingMonth.format(date) === reportingMonth.format(now);
}

function addProductSale(stats, item) {
    const name = item.name || 'Unknown Product';
    const key = item.productId ? 'id:' + item.productId : 'legacy:' + name;
    if (!stats[key]) stats[key] = { name, quantity: 0 };
    stats[key].quantity += Number(item.quantity) || 0;
}

function renderHomeDashboard() {
    // Basic stats
    let totalRevenue = 0;
    let totalOrders = orders.length;
    let totalCustomersCount = customers.length;

    let totalUnpaid = 0;
    let currentAmount = 0;
    let overdueAmount = 0;
    let unknownAgeAmount = 0;
    const overdueBefore = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const carriedByTarget = new Map();
    for (const order of orders) {
        const targetId = order.adjustedWithOrderId;
        if (!targetId) continue;
        if (!carriedByTarget.has(targetId)) carriedByTarget.set(targetId, []);
        carriedByTarget.get(targetId).push(order);
    }
    const now = new Date();

    // Calculate top customer and product stats (this month & overall)
    const customerStatsMonth = Object.create(null);
    const customerStatsAll = Object.create(null);
    const productStatsMonth = Object.create(null);
    const productStatsAll = Object.create(null);

    orders.forEach(order => {
        // Calculate true net revenue (items total + additional costs) instead of totalAmount (which double-counts previous dues)
        const netSales = getOrderRevenue(order);
        totalRevenue += netSales;

        const due = getOrderDue(order);
        if (due > 0 && !isOrderAdjusted(order)) {
            totalUnpaid += due;
            for (const { date, amount } of outstandingByDate(order, carriedByTarget)) {
                if (date === null) unknownAgeAmount += amount;
                else if (date < overdueBefore) overdueAmount += amount;
                else currentAmount += amount;
            }
        }

        const custId = order.customerId;
        const custName = order.customerName || (customers.find(c => orderBelongsToCustomer(order, c)) || {}).name || 'Unknown Customer';
        const orderDate = new Date(order.date);
        const isCurrentMonth = isInReportingMonth(orderDate, now);

        // Customer All-Time Stats
        if (custId) {
            if (!customerStatsAll[custId]) {
                customerStatsAll[custId] = { name: custName, totalRevenue: 0 };
            }
            customerStatsAll[custId].totalRevenue += netSales;

            if (isCurrentMonth) {
                if (!customerStatsMonth[custId]) {
                    customerStatsMonth[custId] = { name: custName, totalRevenue: 0 };
                }
                customerStatsMonth[custId].totalRevenue += netSales;
            }
        }

        // Product Stats
        (order.items || []).forEach(item => {
            addProductSale(productStatsAll, item);
            if (isCurrentMonth) addProductSale(productStatsMonth, item);
        });
    });

    // Find top customer (Month prioritized, fallback to All-Time)
    let topCustomerName = 'None';
    let topCustomerRevenue = 0;
    let isMonthCustomer = false;

    Object.keys(customerStatsMonth).forEach(custId => {
        const stats = customerStatsMonth[custId];
        if (stats.totalRevenue > topCustomerRevenue) {
            topCustomerRevenue = stats.totalRevenue;
            topCustomerName = stats.name;
            isMonthCustomer = true;
        }
    });

    if (topCustomerName === 'None') {
        Object.keys(customerStatsAll).forEach(custId => {
            const stats = customerStatsAll[custId];
            if (stats.totalRevenue > topCustomerRevenue) {
                topCustomerRevenue = stats.totalRevenue;
                topCustomerName = stats.name;
                isMonthCustomer = false;
            }
        });
    }

    // Find top product (Month prioritized, fallback to All-Time)
    let topProductName = 'None';
    let topProductQty = 0;
    let isMonthProduct = false;

    Object.keys(productStatsMonth).forEach(prodName => {
        const stats = productStatsMonth[prodName];
        if (stats.quantity > topProductQty) {
            topProductQty = stats.quantity;
            topProductName = stats.name;
            isMonthProduct = true;
        }
    });

    if (topProductName === 'None') {
        Object.keys(productStatsAll).forEach(prodName => {
            const stats = productStatsAll[prodName];
            if (stats.quantity > topProductQty) {
                topProductQty = stats.quantity;
                topProductName = stats.name;
                isMonthProduct = false;
            }
        });
    }

    document.getElementById('dashTotalRevenue').textContent = `₹${totalRevenue.toFixed(2)}`;

    const topCustomerEl = document.getElementById('dashTopCustomer');
    const topCustomerSubEl = document.getElementById('dashTopCustomerSub');
    if (topCustomerEl && topCustomerSubEl) {
        topCustomerEl.textContent = topCustomerName;
        topCustomerEl.title = topCustomerName;
        topCustomerSubEl.textContent = topCustomerRevenue > 0
            ? `₹${topCustomerRevenue.toFixed(2)} billing${isMonthCustomer ? '' : ' (all time)'}`
            : 'No billing';
    }

    const topProductEl = document.getElementById('dashTopProduct');
    const topProductSubEl = document.getElementById('dashTopProductSub');
    if (topProductEl && topProductSubEl) {
        topProductEl.textContent = topProductName;
        topProductEl.title = topProductName;
        topProductSubEl.textContent = topProductQty > 0
            ? `${topProductQty} units sold${isMonthProduct ? '' : ' (all time)'}`
            : 'No sales';
    }
    const totalUnpaidEl = document.getElementById('dashTotalUnpaid');
    const unpaidBreakdownEl = document.getElementById('dashUnpaidBreakdown');
    if (totalUnpaidEl) {
        totalUnpaidEl.textContent = `₹${totalUnpaid.toFixed(2)}`;
    }
    if (unpaidBreakdownEl) {
        unpaidBreakdownEl.textContent = `Current ₹${currentAmount.toFixed(2)} · Overdue ₹${overdueAmount.toFixed(2)}` +
            (unknownAgeAmount > 0 ? ` · Age unknown ₹${unknownAgeAmount.toFixed(2)}` : '');
    }
}

function showUnpaidModal() {
    const container = document.getElementById('unpaidListContainer');
    if (!container) return;
    
    container.innerHTML = '';
    
    let unpaidOrders = [];
    orders.forEach(order => {
        const due = getOrderDue(order);
        if (due > 0 && !isOrderAdjusted(order)) {
            unpaidOrders.push({
                ...order,
                dueAmount: due
            });
        }
    });
    
    // Sort by date (newest first)
    unpaidOrders.sort((a, b) => new Date(b.date) - new Date(a.date));

    const searchInput = document.getElementById('unpaidSearchInput');
    const query = searchInput ? searchInput.value.trim().toLowerCase() : '';
    if (query) {
        unpaidOrders = unpaidOrders.filter(order => {
            const invoiceNum = getInvoiceNumber(order).toLowerCase();
            const custName = (order.customerName || (customers.find(c => orderBelongsToCustomer(order, c)) || {}).name || '').toLowerCase();
            const phone = (order.customerPhone || '').toLowerCase();
            return invoiceNum.includes(query) || custName.includes(query) || phone.includes(query);
        });
    }
    
    if (unpaidOrders.length === 0) {
        container.innerHTML = query 
            ? `<p style="text-align:center; color:var(--text-secondary); margin-top:20px; font-style:italic;">No unpaid invoices matching "${escapeHtml(query)}".</p>`
            : '<p style="text-align:center; color:var(--text-secondary); margin-top:20px; font-style:italic;">🎉 No unpaid invoices! All dues are clear.</p>';
    } else {
        unpaidOrders.forEach(order => {
            const customerName = order.customerName || (customers.find(c => orderBelongsToCustomer(order, c)) || {}).name || 'Unknown Customer';
            const invoiceNum = getInvoiceNumber(order);
            const dateStr = new Date(order.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
            
            const card = document.createElement('div');
            card.className = 'bill-card';
            card.style.marginBottom = '10px';
            card.style.display = 'flex';
            card.style.justifyContent = 'space-between';
            card.style.alignItems = 'center';
            card.style.padding = '12px';
            card.style.backgroundColor = 'var(--bg-color)';
            card.style.border = '1px solid var(--panel-border)';
            card.style.borderRadius = '8px';
            
            card.innerHTML = `
                <div>
                    <h3 style="margin: 0; font-size: 1.05rem; color: var(--text-color);">${escapeHtml(customerName)}</h3>
                    <div style="font-size: 0.85rem; color: var(--text-secondary); margin-top: 4px; font-weight: 500;">
                        <span>#${escapeHtml(invoiceNum)}</span> &bull; <span>${dateStr}</span>
                    </div>
                </div>
                <div style="text-align: right;">
                    <div style="color: var(--danger-color); font-weight: bold; font-size: 1.1rem;">₹${order.dueAmount.toFixed(2)}</div>
                    <button class="btn btn-secondary" style="padding: 4px 10px; font-size: 0.8rem; margin-top: 6px; border-color: var(--accent-color); color: var(--accent-color); background: transparent;" onclick="closeModal('unpaidModal'); openPaymentModal(${htmlArgument(order.id)})">Pay Now</button>
                </div>
            `;
            container.appendChild(card);
        });
    }
    
    openModal('unpaidModal');
}

function filterUnpaidInvoices() {
    showUnpaidModal();
}

function showTopCustomersModal() {
    const container = document.getElementById('topCustomersListContainer');
    if (!container) return;
    
    container.innerHTML = '';
    
    const now = new Date();
    const customerStats = Object.create(null);
    
    orders.forEach(order => {
        if (order.customerId) {
            const orderDate = new Date(order.date);
            if (isInReportingMonth(orderDate, now)) {
                const custId = order.customerId;
                const custName = order.customerName || (customers.find(c => orderBelongsToCustomer(order, c)) || {}).name || 'Unknown Customer';
                if (!customerStats[custId]) {
                    customerStats[custId] = {
                        id: custId,
                        name: custName,
                        totalRevenue: 0,
                        orderCount: 0
                    };
                }
                const netSales = getOrderRevenue(order);
                customerStats[custId].totalRevenue += netSales;
                customerStats[custId].orderCount += 1;
            }
        }
    });
    
    // Convert to array and sort by revenue
    const sortedCustomers = Object.values(customerStats).sort((a, b) => b.totalRevenue - a.totalRevenue).slice(0, 5);
    
    if (sortedCustomers.length === 0) {
        container.innerHTML = '<p style="text-align:center; color:var(--text-secondary); margin-top:20px; font-style:italic;">No customer activity this month.</p>';
    } else {
        sortedCustomers.forEach((cust, index) => {
            const card = document.createElement('div');
            card.className = 'bill-card';
            card.style.marginBottom = '10px';
            card.style.display = 'flex';
            card.style.justifyContent = 'space-between';
            card.style.alignItems = 'center';
            card.style.padding = '12px';
            card.style.backgroundColor = 'var(--bg-color)';
            card.style.border = '1px solid var(--panel-border)';
            card.style.borderRadius = '8px';
            
            let medal = '';
            if (index === 0) medal = '🥇 ';
            else if (index === 1) medal = '🥈 ';
            else if (index === 2) medal = '🥉 ';
            else medal = `<span style="display:inline-block; width: 24px; text-align: center; color: var(--text-secondary); font-weight: bold;">#${index+1}</span> `;
            
            card.innerHTML = `
                <div style="display: flex; align-items: center; gap: 10px;">
                    <div style="font-size: 1.5rem;">${medal}</div>
                    <div>
                        <h3 style="margin: 0; font-size: 1.05rem; color: var(--text-color);">${escapeHtml(cust.name)}</h3>
                        <div style="font-size: 0.85rem; color: var(--text-secondary); margin-top: 4px; font-weight: 500;">
                            ${cust.orderCount} order${cust.orderCount > 1 ? 's' : ''} this month
                        </div>
                    </div>
                </div>
                <div style="text-align: right;">
                    <div style="color: #10b981; font-weight: bold; font-size: 1.1rem;">₹${cust.totalRevenue.toFixed(2)}</div>
                </div>
            `;
            container.appendChild(card);
        });
    }
    
    openModal('topCustomersModal');
}

function showTopProductsModal() {
    const container = document.getElementById('topProductsListContainer');
    if (!container) return;
    
    container.innerHTML = '';
    
    const now = new Date();
    const productStats = Object.create(null);
    
    orders.forEach(order => {
        const orderDate = new Date(order.date);
        if (isInReportingMonth(orderDate, now)) {
            (order.items || []).forEach(item => addProductSale(productStats, item));
        }
    });
    
    // Convert to array and sort by quantity
    const sortedProducts = Object.values(productStats).sort((a, b) => b.quantity - a.quantity).slice(0, 10);
    
    if (sortedProducts.length === 0) {
        container.innerHTML = '<p style="text-align:center; color:var(--text-secondary); margin-top:20px; font-style:italic;">No product sales this month.</p>';
    } else {
        sortedProducts.forEach((prod, index) => {
            const card = document.createElement('div');
            card.className = 'bill-card';
            card.style.marginBottom = '10px';
            card.style.display = 'flex';
            card.style.justifyContent = 'space-between';
            card.style.alignItems = 'center';
            card.style.padding = '12px';
            card.style.backgroundColor = 'var(--bg-color)';
            card.style.border = '1px solid var(--panel-border)';
            card.style.borderRadius = '8px';
            
            let medal = '';
            if (index === 0) medal = '🥇 ';
            else if (index === 1) medal = '🥈 ';
            else if (index === 2) medal = '🥉 ';
            else medal = `<span style="display:inline-block; width: 24px; text-align: center; color: var(--text-secondary); font-weight: bold;">#${index+1}</span> `;
            
            card.innerHTML = `
                <div style="display: flex; align-items: center; gap: 10px;">
                    <div style="font-size: 1.5rem;">${medal}</div>
                    <div>
                        <h3 style="margin: 0; font-size: 1.05rem; color: var(--text-color);">${escapeHtml(prod.name)}</h3>
                        <div style="font-size: 0.85rem; color: var(--text-secondary); margin-top: 4px; font-weight: 500;">
                            ${prod.quantity} units sold
                        </div>
                    </div>
                </div>
            `;
            container.appendChild(card);
        });
    }
    
    openModal('topProductsModal');
}

// --- View Switching ---
function switchView(viewId) {
    document.getElementById('homeView').style.display = 'none';
    document.getElementById('mainView').style.display = 'none';
    document.getElementById('billsView').style.display = 'none';
    document.getElementById('historyView').style.display = 'none';
    document.getElementById('customersView').style.display = 'none';
    document.getElementById('productsView').style.display = 'none';

    document.getElementById(viewId).style.display = '';

    if (viewId === 'homeView') renderHomeDashboard();
    if (viewId === 'billsView') renderBills();
    if (viewId === 'historyView') renderPaymentHistory();
    if (viewId === 'customersView') renderCustomersList();
    if (viewId === 'productsView') renderProductsList();

    // Update mobile navigation active state
    const mobileBtns = document.querySelectorAll('.mobile-nav-btn');
    mobileBtns.forEach(btn => {
        const onClickStr = btn.getAttribute('onclick') || '';
        if (onClickStr.includes(`switchView('${viewId}')`)) {
            btn.classList.add('active');
        } else if (onClickStr.includes('switchView')) {
            btn.classList.remove('active');
        }
    });

    // Update desktop sidebar active state
    const sidebarBtns = document.querySelectorAll('.sidebar-nav button');
    sidebarBtns.forEach(btn => {
        const onClickStr = btn.getAttribute('onclick') || '';
        if (onClickStr.includes(`switchView('${viewId}')`)) {
            btn.classList.add('btn-primary');
            btn.classList.remove('btn-secondary');
        } else if (onClickStr.includes('switchView')) {
            btn.classList.add('btn-secondary');
            btn.classList.remove('btn-primary');
        }
    });
}

function renderPaymentHistory() {
    const container = document.getElementById('paymentHistoryContainer');
    if (!container) return;
    container.innerHTML = '';

    if (paymentHistory.length === 0) {
        container.innerHTML = '<p style="text-align:center; color:var(--text-secondary); margin-top:20px; font-style:italic;">No payments recorded yet.</p>';
        return;
    }

    const searchInput = document.getElementById('paymentHistorySearchInput');
    const query = searchInput ? searchInput.value.trim().toLowerCase() : '';

    let filteredHistory = paymentHistory;
    if (query) {
        filteredHistory = paymentHistory.filter(pay => {
            const custName = (pay.customerName || '').toLowerCase();
            const mode = (pay.mode || '').toLowerCase();
            const amountStr = (pay.amount || 0).toString();
            const dateStr = new Date(pay.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }).toLowerCase();
            const invoiceIds = pay.details?.allocations?.map(a => a.orderId) || pay.orderIds || [];
            return custName.includes(query) || mode.includes(query) || amountStr.includes(query) ||
                dateStr.includes(query) || pay.details?.reference?.toLowerCase().includes(query) ||
                invoiceIds.some(id => getInvoiceNumber({ id }).toLowerCase().includes(query));
        });
    }

    if (filteredHistory.length === 0) {
        container.innerHTML = `<p style="text-align:center; color:var(--text-secondary); margin-top:20px; font-style:italic;">No payment records found matching "${escapeHtml(query)}".</p>`;
        return;
    }

    const sortedHistory = [...filteredHistory].sort((a, b) => new Date(b.date) - new Date(a.date));

    sortedHistory.forEach(pay => {
        const d = new Date(pay.date);
        const dateString = d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
        const timeString = d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

        const card = document.createElement('div');
        card.className = 'bill-card';
        card.style.marginBottom = '10px';
        card.style.cursor = 'pointer';
        card.onclick = () => viewPaymentBill(pay.id);
        const kind = pay.details?.kind;
        const status = kind === 'reversal' ? 'Reversal' : getPaymentReversal(pay.id) ? 'Reversed' : '';
        const amountPrefix = kind === 'reversal' ? '− ' : kind === 'credit' ? '' : '+ ';
        const amountColor = kind === 'reversal' || status || kind === 'credit' ? 'var(--text-secondary)' : 'var(--success-color)';
        card.innerHTML = `
            <div class="bill-card-header" style="border-bottom: none; padding-bottom: 0;">
                <div>
                    <h3 style="margin:0; font-size:1.05rem; color: var(--text-color);">${escapeHtml(pay.customerName)}</h3>
                    <span class="bill-date" style="display:block; margin-top:4px;">${dateString} at ${timeString}</span>
                </div>
                <div style="text-align: right;">
                    <span style="display:block; color:${amountColor}; font-weight:bold; font-size:1.1rem;">${amountPrefix}₹${pay.amount.toFixed(2)}</span>
                    <span style="font-size:0.8rem; color:var(--text-secondary); background:var(--panel-border); padding:2px 6px; border-radius:4px; margin-top:4px; display:inline-block;">${escapeHtml(pay.mode)}${status ? ' · ' + status : ''}</span>
                </div>
            </div>
        `;
        container.appendChild(card);
    });
}

function viewPaymentBill(paymentId) {
    const payment = paymentHistory.find(p => p.id === paymentId);
    if (!payment) return;
    const details = payment.details;
    const reversal = getPaymentReversal(paymentId);
    const body = document.getElementById('paymentDetailsBody');
    body.replaceChildren();
    const lines = [
        payment.customerName || 'Unknown customer',
        (details?.kind === 'reversal' ? 'Reversed amount' : 'Amount') + ': ₹' + payment.amount.toFixed(2),
        payment.mode + ' · ' + new Date(payment.date).toLocaleString('en-IN')
    ];
    if (details?.reference) lines.push('Reference: ' + details.reference);
    if (reversal) lines.push('Reversed: ' + reversal.details.reason);
    if (details?.reason) lines.push('Reversal reason: ' + details.reason);
    if (details?.credit) {
        lines.push((details.credit > 0 ? 'Credit added: ₹' : 'Credit used or reversed: ₹') +
            Math.abs(details.credit).toFixed(2));
    }
    if (!Array.isArray(details?.allocations)) {
        lines.push('Invoice allocation amounts are unavailable for this older entry.');
    }
    for (const line of lines) {
        const p = document.createElement('p');
        p.textContent = line;
        body.appendChild(p);
    }

    const allocations = details?.allocations || (payment.orderIds || []).map(orderId => ({ orderId }));
    for (const { orderId, amount } of allocations) {
        const order = orders.find(o => o.id === orderId);
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn btn-secondary';
        button.textContent = getInvoiceNumber({ id: orderId }) +
            (amount == null ? '' : ' · ₹' + amount.toFixed(2)) + (order ? '' : ' · Bill unavailable');
        button.disabled = !order;
        button.onclick = () => {
            closeModal('paymentDetailsModal');
            showBillPreviewModal(orderId);
        };
        body.appendChild(button);
    }

    const controls = document.getElementById('paymentReversalControls');
    controls.hidden = !details || !['receipt', 'credit'].includes(details.kind) || !!reversal;
    document.getElementById('paymentReversalReason').value = '';
    document.getElementById('reversePaymentButton').onclick = () => reversePayment(paymentId);
    openModal('paymentDetailsModal');
}

function showBillPreviewModal(orderId) {
    const order = orders.find(o => o.id === orderId);
    if (!order) return;

    const customer = customers.find(c => c.id === order.customerId) || {};
    const customerName = order.customerName || customer.name || 'Customer';
    const customerAddress = order.customerAddress ?? '';
    const invoiceNum = getInvoiceNumber(order);
    const billElement = buildBillHTML(customerName, customerAddress, order.items, getOrderTotal(order), order.previousDue || 0, getOrderPaid(order), order.additionalCost || 0, order.additionalCostReason || '', invoiceNum, isOrderAdjusted(order), order.date);

    document.getElementById('previewDownloadBtn').onclick = () => shareBill(orderId, true);
    document.getElementById('invoiceHistoryBtn').onclick = () => showInvoiceHistory(orderId);
    const previewContent = document.getElementById('billPreviewContent');
    if (!previewContent) return;

    previewContent.innerHTML = '';

    // Convert styles from buildBillHTML element to be responsive inside modal
    billElement.style.position = 'relative';
    billElement.style.left = '0';
    billElement.style.top = '0';
    billElement.style.width = '100%';

    previewContent.appendChild(billElement);

    const printBtn = document.getElementById('previewPrintBtn');
    if (printBtn) {
        printBtn.onclick = () => printInvoice(orderId);
    }

    openModal('billPreviewModal');
}

async function showInvoiceHistory(orderId) {
    const content = document.getElementById('invoiceHistoryContent');
    closeModal('billPreviewModal');
    openModal('invoiceHistoryModal');
    content.textContent = 'Loading invoice history…';
    const { data, error } = await supabaseClient.from('taruchhaya_invoice_audit')
        .select('changed_at,changed_by,action,before_record,after_record')
        .eq('invoice_id', orderId).order('id', { ascending: false }).limit(200);
    if (!signedIn) return;
    if (error || !data.length) {
        content.textContent = error ? 'Could not load the invoice history.' : 'No changes have been recorded since invoice auditing was enabled.';
        return;
    }
    const list = document.createElement('ol');
    for (const entry of data) {
        const item = document.createElement('li');
        const details = document.createElement('details');
        const summary = document.createElement('summary');
        const actions = { INSERT: 'Created', UPDATE: 'Updated', DELETE: 'Deleted' };
        summary.textContent = actions[entry.action] + ' · ' + new Date(entry.changed_at).toLocaleString('en-IN') +
            ' · ' + (entry.changed_by || 'Database maintenance');
        const values = document.createElement('pre');
        values.style.whiteSpace = 'pre-wrap';
        values.style.overflowWrap = 'anywhere';
        values.textContent = JSON.stringify({ Before: entry.before_record, After: entry.after_record }, null, 2);
        details.append(summary, values);
        item.appendChild(details);
        list.appendChild(item);
    }
    content.replaceChildren(list);
}

function csvValue(value) {
    const text = String(value ?? '');
    // Spreadsheet apps can interpret customer-entered values as formulas.
    const safe = typeof value === 'string' && /^[\s]*[=+@-]/.test(text) ? "'" + text : text;
    return '"' + safe.replaceAll('"', '""') + '"';
}

function exportAccountingCsv(kind) {
    if (!signedIn || cloudRevision === null) {
        showToast('Load your cloud records before exporting.', 'error');
        return;
    }
    const invoices = kind === 'invoices';
    const headers = invoices
        ? ['Invoice', 'Issued at', 'Customer ID', 'Customer', 'Current sale', 'Previous due', 'Total', 'Paid', 'Outstanding', 'Carried to']
        : ['Payment ID', 'Payment date', 'Customer ID', 'Customer', 'Type', 'Mode', 'Amount', 'Credit change', 'Reference', 'Invoice allocations', 'Reverses', 'Reason'];
    const rows = invoices
        ? orders.map(o => [getInvoiceNumber(o), o.date, o.customerId, o.customerName, getOrderRevenue(o), o.previousDue,
            getOrderTotal(o), getOrderPaid(o), isOrderAdjusted(o) ? 0 : getOrderDue(o), o.adjustedWithOrderId])
        : paymentHistory.map(p => [p.id, p.date, p.customerId, p.customerName, p.details?.kind || 'legacy', p.mode,
            p.amount, p.details?.credit, p.details?.reference,
            p.details?.allocations?.map(a => getInvoiceNumber({ id: a.orderId }) + ' ' + a.amount.toFixed(2)).join('; '),
            p.details?.reverses, p.details?.reason]);
    downloadFile(new Blob(['\uFEFF', [headers, ...rows].map(row => row.map(csvValue).join(',')).join('\r\n')],
        { type: 'text/csv;charset=utf-8' }), kind + '.csv');
}

// --- Bills Management ---
function setBillsFilter(filterType) {
    currentBillsFilter = filterType;
    document.querySelectorAll('.filter-tab-btn').forEach(btn => {
        if (btn.dataset.filter === filterType) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });
    renderBills();
}

function updateUnpaidBillsBadge() {
    const badge = document.getElementById('unpaidBillsCountBadge');
    if (!badge) return;
    const count = orders.filter(o => getOrderDue(o) > 0 && !isOrderAdjusted(o)).length;
    badge.textContent = count;
    badge.style.display = count > 0 ? 'inline-block' : 'none';
}

function renderBills() {
    updateUnpaidBillsBadge();

    const container = document.getElementById('billsListContainer');
    if (!container) return;
    container.innerHTML = '';
    const selectedCustomer = customers.find(c => String(c.id) === billsCustomerId);
    const clearCustomer = document.getElementById('clearBillsCustomer');
    clearCustomer.hidden = !selectedCustomer;
    clearCustomer.textContent = selectedCustomer ? 'Clear customer filter: ' + selectedCustomer.name : '';

    if (orders.length === 0) {
        container.innerHTML = '<p style="text-align:center; color:var(--text-secondary); margin-top:20px; font-style:italic;">No bills saved yet.</p>';
        return;
    }

    const searchInput = document.getElementById('billSearchInput');
    const query = searchInput ? searchInput.value.trim().toLowerCase() : '';

    // Filter orders based on query and current tab filter
    let filteredOrders = selectedCustomer ? orders.filter(order => orderBelongsToCustomer(order, selectedCustomer)) : orders;

    if (currentBillsFilter === 'unpaid') {
        filteredOrders = filteredOrders.filter(o => getOrderDue(o) > 0 && !isOrderAdjusted(o));
    } else if (currentBillsFilter === 'paid') {
        filteredOrders = filteredOrders.filter(o => getOrderDue(o) <= 0 && !isOrderAdjusted(o));
    }

    if (query) {
        filteredOrders = filteredOrders.filter(o => {
            const invoiceNum = getInvoiceNumber(o).toLowerCase();
            const custName = (o.customerName || (customers.find(c => orderBelongsToCustomer(o, c)) || {}).name || '').toLowerCase();
            const itemsStr = (o.items || []).map(i => i.name).join(' ').toLowerCase();
            const dateStr = new Date(o.date).toLocaleDateString('en-IN').toLowerCase();
            return invoiceNum.includes(query) || custName.includes(query) || itemsStr.includes(query) || dateStr.includes(query);
        });
    }

    if (filteredOrders.length === 0) {
        let emptyMsg = `No bills found matching "${query}".`;
        if (!query) {
            if (currentBillsFilter === 'unpaid') emptyMsg = '🎉 No unpaid bills found! All bills are fully paid.';
            else if (currentBillsFilter === 'paid') emptyMsg = 'No fully paid bills yet.';
        }
        container.innerHTML = `<p style="text-align:center; color:var(--text-secondary); margin-top:20px; font-style:italic;">${escapeHtml(emptyMsg)}</p>`;
        return;
    }

    // Show newest orders first
    const sortedOrders = [...filteredOrders].reverse();

    const groupedOrders = new Map();
    for (const order of sortedOrders) {
        const customer = customers.find(c => orderBelongsToCustomer(order, c));
        const customerId = customer?.id ?? order.customerId;
        const key = customerId ? 'customer:' + customerId : 'invoice:' + order.id;
        if (!groupedOrders.has(key)) {
            groupedOrders.set(key, {
                customerName: customer?.name || order.customerName || 'Unknown Customer',
                customerPhone: customer?.phone || order.customerPhone || '',
                customerOrders: []
            });
        }
        groupedOrders.get(key).customerOrders.push(order);
    }

    const folders = [...groupedOrders.values()];
    for (const folder of folders) {
        folder.customerOrders.sort((a, b) => new Date(b.date) - new Date(a.date));
    }
    folders.sort((a, b) => new Date(b.customerOrders[0].date) - new Date(a.customerOrders[0].date) ||
        a.customerName.localeCompare(b.customerName));

    folders.forEach(({ customerName, customerPhone, customerOrders }, index) => {
        let totalDue = 0;
        customerOrders.forEach(order => {
            if (!isOrderAdjusted(order)) {
                totalDue += getOrderDue(order);
            }
        });

        const folderDiv = document.createElement('div');
        folderDiv.className = 'customer-folder';

        const folderId = 'folder-' + index;

        // Auto-expand the very top folder or expand all if search query is active or unpaid filter is on
        const shouldExpand = index === 0 || query.length > 0 || currentBillsFilter === 'unpaid';

        // Folder Header
        const folderHeader = document.createElement('div');
        folderHeader.className = 'customer-folder-header';
        folderHeader.onclick = () => toggleFolder(folderId);
        folderHeader.innerHTML = `
            <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
                <h3>📁 ${escapeHtml(customerName)}</h3>
                <span class="folder-customer-phone"></span>
                <span class="folder-badge">${customerOrders.length} Bill${customerOrders.length > 1 ? 's' : ''}</span>
                ${totalDue > 0 ? `<span style="font-size:0.85rem; color:var(--danger-color); font-weight:bold; border: 1px solid var(--danger-color); padding: 2px 6px; border-radius: 4px;">Due: ₹${totalDue.toFixed(2)}</span>` : `<span style="font-size:0.85rem; color:var(--success-color); font-weight:bold;">All Paid</span>`}
            </div>
            <span class="folder-icon" id="icon-${folderId}">${shouldExpand ? '▲' : '▼'}</span>
        `;

        folderHeader.querySelector('.folder-customer-phone').textContent = customerPhone;

        // Folder Content (Bills)
        const folderContent = document.createElement('div');
        folderContent.id = folderId;
        folderContent.className = 'customer-folder-content';
        folderContent.style.display = shouldExpand ? 'block' : 'none';

        customerOrders.forEach(order => {
            const dateObj = new Date(order.date);
            const dateString = dateObj.toLocaleDateString('en-IN', {
                day: '2-digit', month: 'short', year: 'numeric',
                hour: '2-digit', minute: '2-digit'
            });

            const billCard = document.createElement('div');
            billCard.className = 'bill-card';

            let itemsHtml = '<ul class="bill-items">';
            (order.items || []).forEach(item => {
                itemsHtml += `<li><span>${escapeHtml(item.name)} × ${escapeHtml(item.quantity)}</span><span>₹${getLineTotal(item).toFixed(2)}</span></li>`;
            });
            if (order.previousDue > 0) {
                itemsHtml += `<li style="border-top: 1px dashed var(--panel-border); padding-top: 6px; margin-top: 4px; color: var(--danger-color); font-weight: 500;"><span>Previous Due</span><span>₹${(parseFloat(order.previousDue) || 0).toFixed(2)}</span></li>`;
            }
            itemsHtml += '</ul>';

            const total = getOrderTotal(order);
            const paid = getOrderPaid(order);
            const pending = getOrderDue(order);

            let footerHtml = '';
            if (isOrderAdjusted(order)) {
                const adjustedOrder = orders.find(o => o.id === order.adjustedWithOrderId);
                let adjustedDateString = 'a newer bill';
                if (adjustedOrder) {
                    const d = new Date(adjustedOrder.date);
                    adjustedDateString = d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) + ' bill';
                }
                footerHtml = `
                    <div style="display:flex; justify-content:space-between; width:100%; margin-bottom: 8px;">
                        <span>Total</span>
                        <strong>₹${total.toFixed(2)}</strong>
                    </div>
                    <div style="text-align:center; color:var(--accent-color); font-size:0.85rem; font-weight:600; padding: 6px; border: 1px dashed var(--accent-color); border-radius: 6px;">
                        🔄 Adjusted with the ${adjustedDateString}
                    </div>
                `;
            } else {
                footerHtml = `
                    <div style="display:flex; justify-content:space-between; width:100%;">
                        <span>Total</span>
                        <strong>₹${total.toFixed(2)}</strong>
                    </div>
                    <div style="display:flex; justify-content:space-between; width:100%; color:var(--text-secondary); font-size:0.9rem;">
                        <span>Paid</span>
                        <span>₹${paid.toFixed(2)}</span>
                    </div>
                    <div style="display:flex; justify-content:space-between; width:100%; color: ${pending > 0 ? 'var(--danger-color)' : 'var(--success-color)'}; font-weight:600;">
                        <span>Due</span>
                        <span>₹${pending.toFixed(2)}</span>
                    </div>
                    ${pending > 0 ? `<button class="btn btn-secondary full-width" style="margin-top:8px; font-size:0.85rem; padding:6px; border-color:var(--success-color); color:var(--success-color); font-weight:600;" onclick="openPaymentModal(${htmlArgument(order.id)})">💰 Record Payment</button>` : `<div style="text-align:center; color:var(--success-color); font-size:0.85rem; margin-top:8px; font-weight:600;">✅ Fully Paid</div>`}
                `;
            }

            const invoiceNum = getInvoiceNumber(order);
            billCard.innerHTML = `
                <div class="bill-card-header">
                    <div>
                        <div style="font-weight: 700; color: var(--accent-color); font-size: 0.95rem; margin-bottom: 2px;"># ${escapeHtml(invoiceNum)}</div>
                        <span class="bill-date">${dateString}</span>
                    </div>
                    <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                        <button class="btn btn-secondary share-bill-btn" onclick="startEditBill(${htmlArgument(order.id)})" title="Edit this bill">✏️ Edit</button>
                        <button class="btn btn-secondary share-bill-btn" onclick="showBillPreviewModal(${htmlArgument(order.id)})">Preview</button>
                        <button class="btn btn-secondary share-bill-btn" onclick="shareBill(${htmlArgument(order.id)})" title="Share this bill">📤 Share</button>
                        <button class="btn btn-primary share-bill-btn" onclick="printInvoice(${htmlArgument(order.id)})" title="Print Invoice">🖨️ Print</button>
                        <button class="btn btn-danger share-bill-btn" style="padding: 0.4rem; min-width: unset;" onclick="deleteBill(${htmlArgument(order.id)})" title="Delete Bill">🗑️</button>
                    </div>
                </div>
                ${itemsHtml}
                <div class="bill-card-footer" style="flex-direction: column; gap: 8px;">
                    ${footerHtml}
                </div>
            `;
            folderContent.appendChild(billCard);
        });

        folderDiv.appendChild(folderHeader);
        folderDiv.appendChild(folderContent);
        container.appendChild(folderDiv);
    });
}

function toggleFolder(folderId) {
    const content = document.getElementById(folderId);
    const icon = document.getElementById('icon-' + folderId);

    if (!content) return;

    if (content.style.display === 'none') {
        content.style.display = 'block';
        if (icon) icon.textContent = '▲';
    } else {
        content.style.display = 'none';
        if (icon) icon.textContent = '▼';
    }
}

function toggleAllFolders(expand) {
    const contents = document.querySelectorAll('.customer-folder-content');
    const icons = document.querySelectorAll('.folder-icon');
    contents.forEach(content => {
        content.style.display = expand ? 'block' : 'none';
    });
    icons.forEach(icon => {
        icon.textContent = expand ? '▲' : '▼';
    });
}

function shareBill(orderId, downloadOnly = false) {
    const order = orders.find(o => o.id === orderId);
    if (!order) {
        showToast('Bill not found.');
        return;
    }

    const customer = customers.find(c => c.id === order.customerId) || {};
    const customerName = order.customerName || customer.name || 'Customer';
    const customerAddress = order.customerAddress ?? '';

    const invoiceNum = getInvoiceNumber(order);
    const billElement = buildBillHTML(customerName, customerAddress, order.items, getOrderTotal(order), order.previousDue || 0, getOrderPaid(order), order.additionalCost || 0, order.additionalCostReason || '', invoiceNum, isOrderAdjusted(order), order.date);
    shareAsImage(billElement, `Bill for ${customerName}`, downloadOnly);
}

function printInvoice(orderId) {
    const order = orders.find(o => o.id === orderId);
    if (!order) return;

    const customer = customers.find(c => c.id === order.customerId) || {};
    const customerName = order.customerName || customer.name || 'Customer';
    const customerAddress = order.customerAddress ?? '';
    const customerPhone = order.customerPhone ?? '';

    const dateObj = new Date(order.date);
    const dateString = dateObj.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Kolkata' });

    const paid = getOrderPaid(order);
    const balanceDue = getOrderDue(order);
    const carriedForward = isOrderAdjusted(order);

    let itemsHtml = '';
    order.items.forEach((item, index) => {
        const unitStr = item.unit ? ` ${item.unit}` : '';
        itemsHtml += `
            <tr>
                <td style="padding: 12px 15px; border-bottom: 1px solid #eee;">${index + 1}</td>
                <td style="padding: 12px 15px; border-bottom: 1px solid #eee;"><strong>${escapeHtml(item.name)}</strong></td>
                <td style="padding: 12px 15px; border-bottom: 1px solid #eee; text-align: center;">${escapeHtml(item.quantity)}${escapeHtml(unitStr)}</td>
                <td style="padding: 12px 15px; border-bottom: 1px solid #eee; text-align: right;">₹ ${item.price.toFixed(2)}</td>
                <td style="padding: 12px 15px; border-bottom: 1px solid #eee; text-align: right;">₹ ${getLineTotal(item).toFixed(2)}</td>
            </tr>
        `;
    });

    const invoiceNum = getInvoiceNumber(order);
    const subTotal = getItemsTotal(order.items || []);
    const total = getOrderTotal(order);
    const roundOff = roundMoney(total - subTotal - (order.previousDue || 0) - (order.additionalCost || 0));
    const printWindow = window.open('', '', 'width=800,height=900');
    if (!printWindow) {
        showToast('Allow pop-ups to print, or download the invoice image from its preview.', 'error');
        return;
    }
    printWindow.document.write(`
    <html>
    <head>
        <title>Invoice - ${escapeHtml(invoiceNum)} - ${escapeHtml(customerName)}</title>
        <style>
            body { font-family: 'Inter', -apple-system, sans-serif; color: #333; margin: 0; padding: 40px; }
            .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 50px; }
            .logo-circle { width: 80px; height: 80px; background-color: #55C478; border-radius: 50%; display: flex; justify-content: center; align-items: center; color: white; font-size: 48px; font-weight: bold; font-family: sans-serif; }
            .invoice-title { font-size: 42px; font-weight: 300; letter-spacing: 2px; }
            .company-info { margin-top: 20px; font-size: 14px; color: #555; line-height: 1.5; }
            .balance-box { text-align: right; margin-top: 20px; }
            .balance-label { font-size: 12px; font-weight: 600; color: #666; text-transform: uppercase; }
            .balance-amount { font-size: 24px; font-weight: bold; margin-top: 5px; }
            .info-section { display: flex; justify-content: space-between; margin-bottom: 40px; font-size: 14px; }
            .bill-to h3 { margin: 0 0 10px 0; color: #888; font-size: 16px; font-weight: 400; }
            .meta-table { text-align: right; color: #555; }
            .meta-table td { padding: 4px 0 4px 20px; }
            .meta-table td:first-child { color: #888; }
            .items-table { width: 100%; border-collapse: collapse; margin-bottom: 30px; font-size: 14px; }
            .items-table th { background-color: #444; color: white; padding: 12px 15px; text-align: left; font-weight: 500; }
            .items-table th.right { text-align: right; }
            .items-table th.center { text-align: center; }
            .totals { width: 45%; margin-left: auto; margin-right: 0; font-size: 14px; }
            .totals-row { display: flex; justify-content: space-between; padding: 8px 15px; }
            .totals-row.bold { font-weight: bold; }
            .balance-due-row { background-color: #F5F5F5; padding: 15px; font-weight: bold; margin-top: 10px; display: flex; justify-content: space-between; }
            .notes { margin-top: 50px; font-size: 14px; color: #666; }
            .notes h4 { color: #888; font-weight: 400; font-size: 16px; margin-bottom: 5px; }
        </style>
    </head>
    <body>
        <div class="header">
            <div>
                <div class="logo-circle">T</div>
                <div class="company-info">
                    <strong>Taruchhaya Enterprise</strong><br>
                    Hat-Tola Road, Pandui<br>
                    Puncha, Purulia - 723151
                </div>
            </div>
            <div style="text-align: right;">
                <div class="invoice-title">INVOICE</div>
                <div class="balance-box">
                    <div class="balance-label">${carriedForward ? 'Balance carried forward' : 'Balance Due'}</div>
                    <div class="balance-amount">₹ ${balanceDue.toFixed(2)}</div>
                </div>
            </div>
        </div>

        <div class="info-section">
            <div class="bill-to">
                <h3>Bill To</h3>
                <strong>${escapeHtml(customerName)}</strong><br>
                ${customerAddress ? `${escapeHtml(customerAddress).split(String.fromCharCode(10)).join('<br>')}<br>` : ''}
                Customer ID: ${escapeHtml(order.customerId)}<br>
            </div>
            <div>
                <table class="meta-table">
                    <tr><td>Invoice No :</td><td><strong>${escapeHtml(invoiceNum)}</strong></td></tr>
                    <tr><td>Invoice Date :</td><td>${dateString}</td></tr>
                    <tr><td>Terms :</td><td>Due On Receipt</td></tr>
                    </table>
            </div>
        </div>

        <table class="items-table">
            <thead>
                <tr>
                    <th>#</th>
                    <th>Item & Description</th>
                    <th class="center">Qty</th>
                    <th class="right">Rate</th>
                    <th class="right">Amount</th>
                </tr>
            </thead>
            <tbody>
                ${itemsHtml}
            </tbody>
        </table>

        <div class="totals">
            <div class="totals-row">
                <span>Sub Total</span>
                <span>₹ ${subTotal.toFixed(2)}</span>
            </div>
            ${order.additionalCost ? `
            <div class="totals-row">
                <span>${escapeHtml(order.additionalCostReason || 'Extra Charges')}</span>
                <span>₹ ${order.additionalCost.toFixed(2)}</span>
            </div>` : ''}
            ${order.previousDue ? `
            <div class="totals-row">
                <span>Previous Due</span>
                <span>₹ ${order.previousDue.toFixed(2)}</span>
            </div>` : ''}
            ${roundOff ? `
            <div class="totals-row">
                <span>Round Off</span>
                <span>₹ ${roundOff.toFixed(2)}</span>
            </div>` : ''}
            <div class="totals-row bold" style="margin-top: 10px; border-top: 1px solid #ddd; padding-top: 10px;">
                <span>Total</span>
                <span>₹ ${total.toFixed(2)}</span>
            </div>
            ${paid > 0 ? `
            <div class="totals-row" style="color: #10b981;">
                <span>Paid</span>
                <span>-₹ ${paid.toFixed(2)}</span>
            </div>` : ''}
            <div class="balance-due-row">
                <span>${carriedForward ? 'Balance carried forward' : 'Balance Due'}</span>
                <span>₹ ${balanceDue.toFixed(2)}</span>
            </div>
        </div>

        <div class="notes">
            <h4>Notes</h4>
            <p>Thanks for your business.</p>
        </div>

        <script>
            window.onload = function() {
                setTimeout(function() {
                    window.print();
                    window.close();
                }, 500);
            }
        </script>
    </body>
    </html>
    `);
    printWindow.document.close();
}

function deleteBill(orderId) {
    const order = orders.find(o => o.id === orderId);
    if (!order) return;

    const customerName = order.customerName ||
        (customers.find(c => c.id === order.customerId) || {}).name ||
        'Customer';
    const dateObj = new Date(order.date);
    const dateString = dateObj.toLocaleDateString('en-IN');

    showCustomConfirm(`Are you sure you want to delete the bill for ${customerName} dated ${dateString}?`).then(async confirmed => {
        if (!confirmed) return;

        const hasActiveAllocation = paymentHistory.some(p => ['receipt', 'credit'].includes(p.details?.kind) &&
            !getPaymentReversal(p.id) && p.details.allocations?.some(a => a.orderId === orderId));
        if (!orders.includes(order) || isOrderAdjusted(order) || getOrderPaid(order) > 0 || hasActiveAllocation) {
            showToast('Only an unpaid bill that has not been carried forward can be deleted. Resolve its payments or carry-forward first.', 'error');
            return;
        }

        const restored = orders.filter(o => o.adjustedWithOrderId === orderId)
            .map(o => ({ ...o, adjustedWithOrderId: null }));
        if (!await saveCloudChanges({ orders: restored.map(orderCloudRow), delete_order: orderId })) return;

        refreshPaymentViews();
        showToast('Bill deleted successfully');
    });
}

// --- Logout ---
function endSession() {
    signedIn = false;
    customers = [];
    products = [];
    orders = [];
    paymentHistory = [];
    currentCustomer = null;
    cart = [];
    document.body.classList.add('checking-session');
    document.getElementById('sessionStatus').hidden = false;
    sessionStorage.removeItem('taruchhaya_auth');
    for (const key of ['loggedIn', 'customers', 'products', 'orders', 'payments']) {
        localStorage.removeItem('taruchhaya_' + key);
    }
    const url = localStorage.getItem('taruchhaya_supabase_url') || SUPABASE_URL;
    localStorage.removeItem('sb-' + new URL(url).hostname.split('.')[0] + '-auth-token');
    window.location.replace('login.html');
}

async function logout() {
    if (cloudWrite) {
        showToast('Wait for the current save before signing out.');
        return;
    }
    document.body.classList.add('checking-session');
    try {
        await supabaseClient.auth.signOut({ scope: 'local' });
    } finally {
        endSession();
    }
}

// --- Mobile Menu ---
function openMobileMenu() {
    const menu = document.getElementById('mobileSideMenu');
    const content = document.getElementById('mobileSideMenuContent');
    menu.style.display = 'block';
    // Trigger reflow
    void menu.offsetWidth;
    menu.style.opacity = '1';
    content.style.transform = 'translateX(0)';
}

function closeMobileMenu(event) {
    // If event is provided and we clicked inside the content, don't close
    if (event && event.target !== document.getElementById('mobileSideMenu') && event.target !== event.currentTarget) {
        return;
    }

    const menu = document.getElementById('mobileSideMenu');
    const content = document.getElementById('mobileSideMenuContent');
    menu.style.opacity = '0';
    content.style.transform = 'translateX(-100%)';
    setTimeout(() => {
        menu.style.display = 'none';
    }, 300);
}

// --- Toast Notification ---
function showToast(message, type = 'success') {
    // Inject CSS if not present
    if (!document.getElementById('toast-styles')) {
        const style = document.createElement('style');
        style.id = 'toast-styles';
        style.innerHTML = `
            .toast-container { position: fixed; bottom: 20px; right: 20px; z-index: 9999; display: flex; flex-direction: column; gap: 10px; pointer-events: none; }
            .toast-message { background: var(--bg-surface, #ffffff); color: var(--text-primary, #1e293b); border-left: 4px solid var(--primary-color, #d4af37); box-shadow: 0 4px 15px rgba(0,0,0,0.1); padding: 12px 20px; border-radius: 8px; font-family: var(--font-primary, 'Inter', sans-serif); font-size: 0.95rem; opacity: 0; transform: translateY(20px); transition: opacity 0.3s cubic-bezier(0.4, 0, 0.2, 1), transform 0.3s cubic-bezier(0.4, 0, 0.2, 1); display: flex; align-items: center; gap: 10px; pointer-events: auto; }
            .toast-message.show { opacity: 1; transform: translateY(0); }
            .toast-message.error { border-left-color: #ef4444; }
            .toast-icon { font-size: 1.2rem; }
        `;
        document.head.appendChild(style);
    }

    // Create container if not present
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        container.className = 'toast-container';
        document.body.appendChild(container);
    }

    // Create toast element
    const toast = document.createElement('div');
    toast.className = `toast-message ${type}`;

    let icon = type === 'error' ? '⚠️' : '✅';
    toast.innerHTML = `<span class="toast-icon">${icon}</span> <span>${escapeHtml(message)}</span>`;

    container.appendChild(toast);

    // Trigger animation
    requestAnimationFrame(() => {
        toast.classList.add('show');
    });

    // Remove after 3 seconds
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => {
            toast.remove();
        }, 300); // Wait for fade out
    }, 3000);
}

// --- Custom Confirm Dialog ---
function showCustomConfirm(message) {
    return new Promise((resolve) => {
        // Inject CSS if not present
        if (!document.getElementById('confirm-styles')) {
            const style = document.createElement('style');
            style.id = 'confirm-styles';
            style.innerHTML = `
                .custom-confirm-overlay { position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0,0,0,0.4); z-index: 10000; display: flex; justify-content: center; align-items: center; opacity: 0; transition: opacity 0.2s ease; backdrop-filter: blur(2px); }
                .custom-confirm-box { background: var(--bg-surface, #fff); padding: 24px; border-radius: 12px; max-width: 400px; width: 90%; box-shadow: 0 10px 25px rgba(0,0,0,0.15); transform: scale(0.95); transition: transform 0.2s cubic-bezier(0.4, 0, 0.2, 1); font-family: var(--font-primary, 'Inter', sans-serif); color: var(--text-primary, #333); }
                .custom-confirm-overlay.show { opacity: 1; }
                .custom-confirm-overlay.show .custom-confirm-box { transform: scale(1); }
                .custom-confirm-message { font-size: 1.05rem; margin-bottom: 24px; line-height: 1.5; color: #1e293b; }
                .custom-confirm-actions { display: flex; justify-content: flex-end; gap: 12px; }
                .custom-confirm-btn { padding: 10px 18px; border: none; border-radius: 6px; font-weight: 600; cursor: pointer; transition: background 0.2s; font-size: 0.95rem; }
                .custom-confirm-cancel { background: #f1f5f9; color: #475569; }
                .custom-confirm-cancel:hover { background: #e2e8f0; color: #1e293b; }
                .custom-confirm-ok { background: #ef4444; color: #fff; }
                .custom-confirm-ok:hover { background: #dc2626; }
            `;
            document.head.appendChild(style);
        }

        const overlay = document.createElement('div');
        overlay.className = 'custom-confirm-overlay';

        const box = document.createElement('div');
        box.className = 'custom-confirm-box';

        const msg = document.createElement('div');
        msg.className = 'custom-confirm-message';
        msg.textContent = message;

        const actions = document.createElement('div');
        actions.className = 'custom-confirm-actions';

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'custom-confirm-btn custom-confirm-cancel';
        cancelBtn.textContent = 'Cancel';

        const okBtn = document.createElement('button');
        okBtn.className = 'custom-confirm-btn custom-confirm-ok';
        okBtn.textContent = 'Delete / Proceed';

        actions.appendChild(cancelBtn);
        actions.appendChild(okBtn);
        box.appendChild(msg);
        box.appendChild(actions);
        overlay.appendChild(box);
        document.body.appendChild(overlay);

        // trigger animation
        requestAnimationFrame(() => overlay.classList.add('show'));

        const cleanup = () => {
            overlay.classList.remove('show');
            setTimeout(() => overlay.remove(), 200);
        };

        cancelBtn.onclick = () => { cleanup(); resolve(false); };
        okBtn.onclick = () => { cleanup(); resolve(true); };
    });
}



