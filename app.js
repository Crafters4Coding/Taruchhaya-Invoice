// --- Authentication Check ---
// if (localStorage.getItem('taruchhaya_loggedIn') !== 'true') {
//     window.location.href = 'login.html';
// }

// --- State ---
let customers = JSON.parse(localStorage.getItem('taruchhaya_customers')) || [];
let products = JSON.parse(localStorage.getItem('taruchhaya_products')) || [];

// Remove mock data if it exists in local storage
customers = customers.filter(c => c.id !== 'cust_1' && c.id !== 'cust_2');
products = products.filter(p => p.id !== 'prod_1' && p.id !== 'prod_2' && p.id !== 'prod_3');
localStorage.setItem('taruchhaya_customers', JSON.stringify(customers));
localStorage.setItem('taruchhaya_products', JSON.stringify(products));

let orders = JSON.parse(localStorage.getItem('taruchhaya_orders')) || [];
let paymentHistory = JSON.parse(localStorage.getItem('taruchhaya_payments')) || [];

let currentCustomer = null;
let cart = []; // Array of { productId, quantity, price, name }
let editingCustomerId = null;
let editingProductId = null;
let editingOrderId = null;
let currentBillsFilter = 'all'; // 'all' | 'unpaid' | 'paid'

function getInvoiceNumber(order) {
    if (!order || !order.id) return '';
    const parts = order.id.split('_');
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
    if (!isNaN(directTotal) && directTotal > 0) {
        return Math.round(directTotal * 100) / 100;
    }
    // Calculate from items + extra costs
    const itemsSum = (order.items || []).reduce((sum, item) => {
        const p = parseFloat(item.price) || 0;
        const q = parseFloat(item.quantity) || 0;
        return sum + (p * q);
    }, 0);
    const addCost = parseFloat(order.additionalCost ?? order.additional_cost ?? 0) || 0;
    const prevDue = parseFloat(order.previousDue ?? order.previous_due ?? 0) || 0;
    const computed = itemsSum + addCost + prevDue;
    return Math.round(computed * 100) / 100;
}

function getOrderPaid(order) {
    if (!order) return 0;
    const paid = parseFloat(order.paidAmount ?? order.paid_amount ?? 0);
    return isNaN(paid) ? 0 : Math.round(paid * 100) / 100;
}

function getOrderDue(order) {
    if (!order) return 0;
    const total = getOrderTotal(order);
    const paid = getOrderPaid(order);
    const due = Math.round((total - paid) * 100) / 100;
    return due > 0.005 ? due : 0;
}

// Robust matcher tolerant of ID type (string vs number), phone, or customer name
function orderBelongsToCustomer(order, customer) {
    if (!order || !customer) return false;
    // Match by ID
    if (order.customerId && customer.id && String(order.customerId).trim() === String(customer.id).trim()) {
        return true;
    }
    // Match by phone if both have non-empty phone
    if (order.customerPhone && customer.phone) {
        const p1 = String(order.customerPhone).replace(/\D/g, '');
        const p2 = String(customer.phone).replace(/\D/g, '');
        if (p1.length >= 7 && p1 === p2) return true;
    }
    // Match by customer name (case-insensitive, trimmed)
    const orderName = (order.customerName || '').trim().toLowerCase();
    const custName = (customer.name || '').trim().toLowerCase();
    if (orderName && custName && orderName === custName) {
        return true;
    }
    return false;
}

function isOrderAdjusted(order) {
    if (!order || !order.adjustedWithOrderId) return false;
    return orders.some(o => o.id === order.adjustedWithOrderId);
}

function getCustomerTotalDue(customer) {
    if (!customer) return 0;
    let totalDue = 0;
    orders.forEach(order => {
        if (orderBelongsToCustomer(order, customer) && !isOrderAdjusted(order)) {
            totalDue += getOrderDue(order);
        }
    });
    return Math.round(totalDue * 100) / 100;
}

// --- Data Healing Function: Rebuilds order rollover chains & prevents double-counted dues ---
function healOrdersData() {
    if (!orders || orders.length === 0) return;
    let modified = false;

    // 1. Ensure basic numerical validity of orders
    orders.forEach(order => {
        const safeTotal = getOrderTotal(order);
        if (order.totalAmount !== safeTotal) {
            order.totalAmount = safeTotal;
            modified = true;
        }
        if (order.paidAmount > safeTotal && safeTotal > 0) {
            order.paidAmount = safeTotal;
            modified = true;
        }
        if (isNaN(order.paidAmount) || order.paidAmount < 0) {
            order.paidAmount = 0;
            modified = true;
        }
        // If adjustedWithOrderId points to a non-existent order, clear it
        if (order.adjustedWithOrderId && !orders.some(o => o.id === order.adjustedWithOrderId)) {
            order.adjustedWithOrderId = null;
            modified = true;
        }
    });

    // 2. Reconstruct rollover chains for past orders where previous dues were rolled into a newer bill
    const customerBuckets = {};
    orders.forEach(order => {
        const key = order.customerId || (order.customerName || '').trim().toLowerCase() || 'unknown';
        if (!customerBuckets[key]) customerBuckets[key] = [];
        customerBuckets[key].push(order);
    });

    Object.values(customerBuckets).forEach(custOrders => {
        // Sort oldest first
        custOrders.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

        for (let i = 0; i < custOrders.length; i++) {
            const currentOrder = custOrders[i];
            const prevDueVal = parseFloat(currentOrder.previousDue || currentOrder.previous_due || 0);

            // If currentOrder rolled over previous dues, all earlier unadjusted orders should point to this rollover order
            if (prevDueVal > 0) {
                for (let j = 0; j < i; j++) {
                    const earlierOrder = custOrders[j];
                    if (!earlierOrder.adjustedWithOrderId) {
                        earlierOrder.adjustedWithOrderId = currentOrder.id;
                        modified = true;
                    }
                }
            }
        }
    });

    if (modified) {
        localStorage.setItem('taruchhaya_orders', JSON.stringify(orders));
        if (typeof cloudUpsertOrder === 'function') {
            orders.forEach(o => cloudUpsertOrder(o));
        }
        console.log('Orders data successfully healed and synchronized.');
    }
}

// Run healing once on script evaluation
healOrdersData();

// --- Supabase Cloud Sync Logic ---
// You can enter your credentials here to hardcode them, 
// or set them dynamically from the "Cloud Settings" modal in the application.
const SUPABASE_URL = "https://cofigoxqaltwdetcodug.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNvZmlnb3hxYWx0d2RldGNvZHVnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk4ODI1NDMsImV4cCI6MjA5NTQ1ODU0M30.7ZXIY6e8MNlMQb08nDNOe69cSlTl8M6xlJOKw8_h3wE";

let supabaseClient = null;

function initSupabase() {
    const url = localStorage.getItem('taruchhaya_supabase_url') || SUPABASE_URL || '';
    const key = localStorage.getItem('taruchhaya_supabase_key') || SUPABASE_KEY || '';

    if (url && key) {
        try {
            if (window.supabase) {
                supabaseClient = window.supabase.createClient(url, key);
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

async function loadCloudData() {
    if (!initSupabase()) {
        updateCloudStatus('disconnected');
        return;
    }

    updateCloudStatus('syncing');

    try {
        const [resCust, resProd, resOrd, resPay] = await Promise.all([
            supabaseClient.from('customers').select('*'),
            supabaseClient.from('products').select('*'),
            supabaseClient.from('orders').select('*'),
            supabaseClient.from('payments').select('*')
        ]);

        if (resCust.error) throw resCust.error;
        if (resProd.error) throw resProd.error;
        if (resOrd.error) throw resOrd.error;
        if (resPay.error) throw resPay.error;

        const dbCust = resCust.data || [];
        const dbProd = resProd.data || [];
        const dbOrd = resOrd.data || [];
        const dbPay = resPay.data || [];

        // Check if DB is completely empty but local has data => Auto-migrate local to cloud
        const localCust = JSON.parse(localStorage.getItem('taruchhaya_customers')) || [];
        const localProd = JSON.parse(localStorage.getItem('taruchhaya_products')) || [];
        const localOrd = JSON.parse(localStorage.getItem('taruchhaya_orders')) || [];
        const localPay = JSON.parse(localStorage.getItem('taruchhaya_payments')) || [];

        if (dbCust.length === 0 && dbProd.length === 0 && dbOrd.length === 0 && dbPay.length === 0 &&
            (localCust.length > 0 || localProd.length > 0 || localOrd.length > 0 || localPay.length > 0)) {

            console.log('Database is empty. Migrating local data to Supabase...');

            if (localCust.length > 0) {
                const mapCust = localCust.map(c => ({ id: c.id, name: c.name, phone: c.phone || '', address: c.address || '', created_at: c.createdAt || new Date().toISOString() }));
                const { error } = await supabaseClient.from('customers').insert(mapCust);
                if (error) throw error;
            }

            if (localProd.length > 0) {
                const mapProd = localProd.map(p => ({ id: p.id, name: p.name, price: p.price, unit: p.unit || 'pcs' }));
                const { error } = await supabaseClient.from('products').insert(mapProd);
                if (error) throw error;
            }

            if (localOrd.length > 0) {
                const mapOrd = localOrd.map(o => ({
                    id: o.id,
                    customer_id: o.customerId,
                    customer_name: o.customerName || '',
                    items: o.items || [],
                    items_total: o.itemsTotal || 0,
                    previous_due: o.previousDue || 0,
                    additional_cost: o.additionalCost || 0,
                    additional_cost_reason: o.additionalCostReason || '',
                    total_amount: o.totalAmount || 0,
                    paid_amount: o.paidAmount || 0,
                    date: o.date || new Date().toISOString(),
                    adjusted_with_order_id: o.adjustedWithOrderId || null
                }));
                const { error } = await supabaseClient.from('orders').insert(mapOrd);
                if (error) throw error;
            }

            if (localPay.length > 0) {
                const mapPay = localPay.map(p => ({
                    id: p.id,
                    customer_id: p.customerId,
                    customer_name: p.customerName || '',
                    amount: p.amount || 0,
                    mode: p.mode || 'Cash',
                    date: p.date || new Date().toISOString()
                }));
                const { error } = await supabaseClient.from('payments').insert(mapPay);
                if (error) throw error;
            }

            showToast('Local data migrated to Supabase cloud successfully!');
            updateCloudStatus('connected');
            return;
        }

        // If cloud database has data, merge safely rather than blindly wiping local data
        if (dbCust.length > 0) {
            customers = dbCust.map(r => ({
                id: r.id,
                name: r.name,
                phone: r.phone || '',
                address: r.address || '',
                createdAt: r.created_at
            }));
        } else if (localCust.length > 0) {
            customers = localCust;
        }

        if (dbProd.length > 0) {
            products = dbProd.map(r => ({
                id: r.id,
                name: r.name,
                price: parseFloat(r.price),
                unit: r.unit || 'pcs'
            }));
        } else if (localProd.length > 0) {
            products = localProd;
        }

        if (dbOrd.length > 0) {
            orders = dbOrd.map(r => ({
                id: r.id,
                customerId: r.customer_id,
                customerName: r.customer_name || '',
                items: r.items || [],
                itemsTotal: parseFloat(r.items_total || 0),
                previousDue: parseFloat(r.previous_due || 0),
                additionalCost: parseFloat(r.additional_cost || 0),
                additionalCostReason: r.additional_cost_reason || '',
                totalAmount: parseFloat(r.total_amount || 0),
                paidAmount: parseFloat(r.paid_amount || 0),
                date: r.date,
                adjustedWithOrderId: r.adjusted_with_order_id || null
            }));
        } else if (localOrd.length > 0) {
            orders = localOrd;
        }

        if (dbPay.length > 0) {
            paymentHistory = dbPay.map(r => ({
                id: r.id,
                customerId: r.customer_id,
                customerName: r.customer_name || '',
                amount: parseFloat(r.amount || 0),
                mode: r.mode || 'Cash',
                date: r.date
            }));
        } else if (localPay.length > 0) {
            paymentHistory = localPay;
        }

        // Heal orders data after cloud sync
        healOrdersData();

        // Cache back to local storage
        localStorage.setItem('taruchhaya_customers', JSON.stringify(customers));
        localStorage.setItem('taruchhaya_products', JSON.stringify(products));
        localStorage.setItem('taruchhaya_orders', JSON.stringify(orders));
        localStorage.setItem('taruchhaya_payments', JSON.stringify(paymentHistory));

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

        updateCloudStatus('connected');

        // --- Setup Realtime Subscriptions ---
        if (!window.realtimeSubscribed) {
            supabaseClient
                .channel('schema-db-changes')
                .on('postgres_changes', { event: '*', schema: 'public', table: 'customers' }, payload => {
                    handleRealtimeChange('customers', payload);
                })
                .on('postgres_changes', { event: '*', schema: 'public', table: 'products' }, payload => {
                    handleRealtimeChange('products', payload);
                })
                .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, payload => {
                    handleRealtimeChange('orders', payload);
                })
                .on('postgres_changes', { event: '*', schema: 'public', table: 'payments' }, payload => {
                    handleRealtimeChange('payments', payload);
                })
                .subscribe();
            window.realtimeSubscribed = true;
        }

        // We use a toast only if this is a manual refresh, or initial load, but skip it to not annoy the user on background syncs
        if (!window.initialLoadDone) {
            showToast('Connected to Cloud');
            window.initialLoadDone = true;
        }
    } catch (err) {
        console.error('Failed to load Supabase cloud data:', err);
        updateCloudStatus('error', err.message || 'Check connection/credentials');
    }
}

// --- Realtime Change Handler ---
let realtimeTimeout = null;
function handleRealtimeChange(table, payload) {
    // Debounce to prevent multiple rapid fetches
    if (realtimeTimeout) clearTimeout(realtimeTimeout);
    realtimeTimeout = setTimeout(() => {
        loadCloudData();
    }, 500);
}

async function cloudUpsertCustomer(customer) {
    if (!supabaseClient) return;
    try {
        const { error } = await supabaseClient.from('customers').upsert({
            id: customer.id,
            name: customer.name,
            phone: customer.phone || '',
            address: customer.address || '',
            created_at: customer.createdAt || new Date().toISOString()
        });
        if (error) throw error;
        updateCloudStatus('connected');
    } catch (err) {
        console.error('Cloud save failed for customer:', err);
        updateCloudStatus('error', 'Failed to save customer to cloud: ' + err.message);
    }
}

async function cloudDeleteCustomer(customerId) {
    if (!supabaseClient) return;
    try {
        const { error } = await supabaseClient.from('customers').delete().eq('id', customerId);
        if (error) throw error;
        updateCloudStatus('connected');
    } catch (err) {
        console.error('Cloud delete failed for customer:', err);
        updateCloudStatus('error', 'Failed to delete customer from cloud: ' + err.message);
    }
}

async function cloudUpsertProduct(product) {
    if (!supabaseClient) return;
    try {
        const { error } = await supabaseClient.from('products').upsert({
            id: product.id,
            name: product.name,
            price: product.price,
            unit: product.unit || 'pcs'
        });
        if (error) throw error;
        updateCloudStatus('connected');
    } catch (err) {
        console.error('Cloud save failed for product:', err);
        updateCloudStatus('error', 'Failed to save product to cloud: ' + err.message);
    }
}

async function cloudDeleteProduct(productId) {
    if (!supabaseClient) return;
    try {
        const { error } = await supabaseClient.from('products').delete().eq('id', productId);
        if (error) throw error;
        updateCloudStatus('connected');
    } catch (err) {
        console.error('Cloud delete failed for product:', err);
        updateCloudStatus('error', 'Failed to delete product from cloud: ' + err.message);
    }
}

async function cloudUpsertOrder(order) {
    if (!supabaseClient) return;
    try {
        const { error } = await supabaseClient.from('orders').upsert({
            id: order.id,
            customer_id: order.customerId,
            customer_name: order.customerName || '',
            items: order.items || [],
            items_total: order.itemsTotal || 0,
            previous_due: order.previousDue || 0,
            additional_cost: order.additionalCost || 0,
            additional_cost_reason: order.additionalCostReason || '',
            total_amount: order.totalAmount || 0,
            paid_amount: order.paidAmount || 0,
            date: order.date || new Date().toISOString(),
            adjusted_with_order_id: order.adjustedWithOrderId || null
        });
        if (error) throw error;
        updateCloudStatus('connected');
    } catch (err) {
        console.error('Cloud save failed for order:', err);
        updateCloudStatus('error', 'Failed to save order to cloud: ' + err.message);
    }
}

async function cloudDeleteOrder(orderId) {
    if (!supabaseClient) return;
    try {
        const { error } = await supabaseClient.from('orders').delete().eq('id', orderId);
        if (error) throw error;
        updateCloudStatus('connected');
    } catch (err) {
        console.error('Cloud delete failed for order:', err);
        updateCloudStatus('error', 'Failed to delete order from cloud: ' + err.message);
    }
}

async function cloudInsertPayment(payment) {
    if (!supabaseClient) return;
    try {
        const { error } = await supabaseClient.from('payments').insert({
            id: payment.id,
            customer_id: payment.customerId,
            customer_name: payment.customerName || '',
            amount: payment.amount || 0,
            mode: payment.mode || 'Cash',
            date: payment.date || new Date().toISOString()
        });
        if (error) throw error;
        updateCloudStatus('connected');
    } catch (err) {
        console.error('Cloud save failed for payment:', err);
        updateCloudStatus('error', 'Failed to save payment to cloud: ' + err.message);
    }
}


// --- Initialization ---
document.addEventListener('DOMContentLoaded', () => {
    // No mock data injection. Data is completely managed by the user locally.

    renderCustomerSelect();
    renderProductSelect();
    if (typeof renderProductsList === 'function') renderProductsList();
    renderBills();
    renderCart(); // Ensure empty state is shown on load

    // Set everyday's date in sidebar and mobile header
    const today = new Date();
    const formattedDate = today.toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });

    const dateElem = document.getElementById('sidebarDate');
    if (dateElem) dateElem.textContent = formattedDate;

    const mobileDateElem = document.getElementById('mobileHeaderDate');
    if (mobileDateElem) mobileDateElem.textContent = formattedDate;

    switchView('homeView');

    // Load cloud data asynchronously
    loadCloudData();
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

function saveCustomer(e) {
    e.preventDefault();
    const nameInput = document.getElementById('newCustomerName');
    const phoneInput = document.getElementById('newCustomerPhone');
    const addressInput = document.getElementById('newCustomerAddress');

    const name = nameInput.value.trim();
    const phone = phoneInput.value.trim();
    if (!name || !phone) {
        showToast('Customer Name and Phone Number are required.');
        return;
    }

    if (editingCustomerId) {
        const customer = customers.find(c => c.id === editingCustomerId);
        if (customer) {
            customer.name = name;
            customer.phone = phone;
            customer.address = addressInput ? addressInput.value.trim() : '';
            // Sync edited customer to cloud
            cloudUpsertCustomer(customer);
        }
    } else {
        const newCustomer = {
            id: 'cust_' + Date.now(),
            name: name,
            phone: phone,
            address: addressInput ? addressInput.value.trim() : '',
            createdAt: new Date().toISOString()
        };
        customers.push(newCustomer);
        // Sync new customer to cloud
        cloudUpsertCustomer(newCustomer);
        
        // Auto-select in combobox
        setTimeout(() => {
            selectCustomerFromCombobox(newCustomer.id);
        }, 50);
    }

    localStorage.setItem('taruchhaya_customers', JSON.stringify(customers));

    renderCustomerSelect();
    if (typeof renderCustomersList === 'function') {
        renderCustomersList();
    }
    closeModal('customerModal');
    showToast(editingCustomerId ? 'Customer updated successfully' : 'Customer added successfully', 'success');
}

function deleteCustomer(id) {
    const customer = customers.find(c => c.id === id);
    if (!customer) return;

    showCustomConfirm(`Are you sure you want to delete ${customer.name}?`).then(confirmed => {
        if (!confirmed) return;

        customers = customers.filter(c => c.id !== id);
        localStorage.setItem('taruchhaya_customers', JSON.stringify(customers));

        // Sync delete to cloud
        if (typeof cloudDeleteCustomer === 'function') {
            cloudDeleteCustomer(id);
        }

        // If currently selected customer is deleted, reset selection
        if (currentCustomer && currentCustomer.id === id) {
            currentCustomer = null;
            const searchInput = document.getElementById('customerSearch');
            if (searchInput) searchInput.value = '';
            cart = [];
            if (typeof renderCart === 'function') renderCart();
            if (typeof updateOrderStepUI === 'function') updateOrderStepUI();
        }

        if (typeof renderCustomerSelect === 'function') renderCustomerSelect();
        if (typeof renderCustomersList === 'function') renderCustomersList();
        showToast('Customer deleted successfully.', 'success');
    });
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

function saveProduct(e) {
    e.preventDefault();
    const nameInput = document.getElementById('newProductName');
    const priceInput = document.getElementById('newProductPrice');
    const unitInput = document.getElementById('newProductUnit');

    const name = nameInput.value.trim();
    const price = parseFloat(priceInput.value);
    const unit = unitInput ? unitInput.value : 'pcs';

    if (!name || isNaN(price) || price < 0) {
        showToast('Please enter a valid product name and price.');
        return;
    }

    if (editingProductId) {
        const product = products.find(p => p.id === editingProductId);
        if (product) {
            product.name = name;
            product.price = price;
            product.unit = unit;
            // Sync edited product to cloud
            cloudUpsertProduct(product);
        }
    } else {
        const newProduct = {
            id: 'prod_' + Date.now(),
            name: name,
            price: price,
            unit: unit
        };
        products.push(newProduct);
        // Sync new product to cloud
        cloudUpsertProduct(newProduct);
    }

    localStorage.setItem('taruchhaya_products', JSON.stringify(products));

    renderProductSelect();
    if (typeof renderProductsList === 'function') {
        renderProductsList();
    }

    closeModal('productModal');
}

async function deleteProduct(productId) {
    // Don't allow deleting if product is in the current cart
    if (cart.some(item => item.productId === productId)) {
        showToast('Cannot delete a product that is currently in the cart. Remove it from the cart first.');
        return;
    }
    if (!(await showCustomConfirm('Delete this product permanently?'))) return;

    products = products.filter(p => p.id !== productId);
    localStorage.setItem('taruchhaya_products', JSON.stringify(products));
    // Sync delete to cloud
    cloudDeleteProduct(productId);

    renderProductSelect();
    if (typeof renderProductsList === 'function') {
        renderProductsList();
    }
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
        container.innerHTML = `<p style="text-align:center; color:var(--text-secondary); margin-top:20px; font-style:italic;">No products found matching "${searchInput.value.replace(/"/g, '&quot;')}".</p>`;
        return;
    }

    const sortedProducts = [...filtered].sort((a, b) => a.name.localeCompare(b.name));

    sortedProducts.forEach(prod => {
        const unitDisplay = prod.unit ? ` / ${prod.unit}` : '';

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
                <h3 style="margin: 0; font-size: 1.25rem; font-weight: 700; color: #1e293b;">${prod.name}</h3>
                <div style="margin-top: 4px; display: flex; flex-direction: column; gap: 2px;">
                    <span style="font-size: 0.9rem; color: #64748b;">Unit: ${prod.unit || 'pcs'}</span>
                </div>
            </div>
            
            <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; margin-top: 5px;">
                <span style="color: var(--success-color); font-weight: 700; font-size: 1.1rem; flex: 1;">
                    ₹${prod.price.toFixed(2)}${unitDisplay}
                </span>
                
                <div style="display: flex; gap: 12px; align-items: center;">
                    <button class="btn btn-secondary" style="padding: 4px 12px; font-size: 0.9rem; border-color: var(--accent-color); color: var(--accent-color); background: transparent; border-radius: 8px; display: flex; align-items: center; gap: 4px;" onclick="editProduct('${prod.id}')">✏️ Edit</button>
                    
                    <button class="btn-danger" style="padding: 4px 8px; font-size: 0.9rem; border: none; background: transparent; display: flex; align-items: center; gap: 4px; cursor: pointer; color: var(--danger-color);" onclick="deleteProduct('${prod.id}')">🗑️ Delete</button>
                </div>
            </div>
        `;
        container.appendChild(card);
    });
}

// --- Cart & Order Logic ---
function addProductToCart() {
    if (!currentCustomer) {
        showToast('Please select a customer first.');
        return;
    }

    const select = document.getElementById('productSelect');
    const qtyInput = document.getElementById('productQuantity');
    const priceOverrideInput = document.getElementById('productPriceOverride');

    if (!select.value) {
        showToast('Please select a product.');
        return;
    }

    const productId = select.value;
    const quantity = parseInt(qtyInput.value, 10);

    if (isNaN(quantity) || quantity <= 0) {
        showToast('Please enter a valid quantity (must be 1 or more).');
        return;
    }

    const product = products.find(p => p.id === productId);
    if (!product) {
        showToast('Selected product not found. Please refresh and try again.');
        return;
    }

    // Determine the price to use
    let price = product.price;
    if (priceOverrideInput && priceOverrideInput.value !== '') {
        const overridePrice = parseFloat(priceOverrideInput.value);
        if (!isNaN(overridePrice) && overridePrice >= 0) {
            price = overridePrice;
        }
    }

    // If already in cart, increase quantity and update price
    const existingItem = cart.find(item => item.productId === productId);

    if (existingItem) {
        existingItem.quantity += quantity;
        if (priceOverrideInput && priceOverrideInput.value !== '') {
            existingItem.price = price;
        }
    } else {
        cart.push({
            productId: product.id,
            name: product.name,
            price: price,
            quantity: quantity,
            unit: product.unit || 'pcs'
        });
    }

    // Reset inputs
    select.value = '';
    qtyInput.value = '1';
    if (priceOverrideInput) priceOverrideInput.value = '';

    renderCart();
}

function removeFromCart(productId) {
    cart = cart.filter(item => item.productId !== productId);
    renderCart();
}

function updateCartQuantity(productId, newQty) {
    const qty = parseFloat(newQty);
    if (isNaN(qty) || qty <= 0) {
        removeFromCart(productId);
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
    if (isNaN(price) || price < 0) {
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
                    <div style="font-weight: 700; font-size: 1.05rem; color: var(--text-primary);">${cust.name}</div>
                    <div style="font-size: 0.9rem; color: var(--text-secondary); margin-top: 4px;">📞 ${cust.phone || 'N/A'} ${cust.address ? '· 📍 ' + cust.address : ''}</div>
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
                quickAddProductToCart(prod.id);
                if (dropdown) dropdown.style.display = 'none';
                const searchInput = document.getElementById('productSearch');
                if (searchInput) searchInput.value = '';
            };

            const unitDisplay = prod.unit ? ` / ${prod.unit}` : '';
            item.innerHTML = `
                <div>
                    <div style="font-weight: 700; font-size: 1.05rem; color: var(--text-primary);">${prod.name}</div>
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
        const itemTotal = item.price * item.quantity;
        grandTotal += itemTotal;

        const card = document.createElement('div');
        card.className = 'cart-item-card';
        card.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: flex-start; width: 100%; gap: 8px;">
                <div style="flex: 1; min-width: 0;">
                    <div style="font-weight: 700; font-size: 1.05rem; color: var(--text-primary); line-height: 1.35; word-break: break-word;">${item.name}</div>
                    <div style="display: flex; align-items: center; gap: 6px; margin-top: 6px; flex-wrap: wrap;">
                        <span style="font-size: 0.88rem; font-weight: 600; color: var(--text-secondary);">Rate: ₹</span>
                        <input type="number" value="${item.price.toFixed(2)}" step="0.01" min="0" onchange="updateCartPrice('${item.productId}', this.value)" style="width: 90px; padding: 5px 8px; border: 1.5px solid var(--panel-border); border-radius: 8px; font-size: 0.98rem; font-weight: 700; color: var(--accent-color); background: var(--input-bg); outline: none;">
                        <span style="font-size: 0.85rem; color: var(--text-secondary);">/ ${item.unit || 'pcs'}</span>
                    </div>
                </div>
                <button onclick="removeFromCart('${item.productId}')" style="background: rgba(239,68,68,0.1); border: none; color: var(--danger-color); font-size: 1.15rem; width: 36px; height: 36px; border-radius: 10px; display: flex; align-items: center; justify-content: center; cursor: pointer; flex-shrink: 0;" title="Remove">✕</button>
            </div>
            
            <div style="display: flex; justify-content: space-between; align-items: center; width: 100%; margin-top: 2px; padding-top: 8px; border-top: 1px dashed rgba(0,0,0,0.08);">
                <div style="display: flex; align-items: center; gap: 8px;">
                    <span style="font-size: 0.88rem; font-weight: 600; color: var(--text-secondary);">Qty:</span>
                    <input type="number" value="${item.quantity}" min="0.01" step="any" onchange="updateCartQuantity('${item.productId}', this.value)" style="width: 80px; padding: 6px 10px; border: 1.5px solid var(--panel-border); border-radius: 8px; font-size: 1.05rem; font-weight: 700; color: var(--text-primary); background: var(--input-bg); outline: none; text-align: center;">
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
    const additionalCost = parseFloat(additionalCostAmountInput ? additionalCostAmountInput.value : 0) || 0;

    let rawFinalTotal = grandTotal + previousDue + additionalCost;
    let finalTotal = rawFinalTotal;
    if (rawFinalTotal % 1 !== 0) {
        finalTotal = Math.round(rawFinalTotal);
    }

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
    if (!currentCustomer) {
        showToast('Please select a customer first.');
        return;
    }
    if (cart.length === 0) {
        showToast('Cart is empty. Please add products before placing an order.');
        return;
    }

    const itemsTotal = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);

    const additionalCostAmountInput = document.getElementById('additionalCostAmount');
    const additionalCost = parseFloat(additionalCostAmountInput ? additionalCostAmountInput.value : 0) || 0;
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
            confirmText += `<br><span style="font-size:1rem; color:#64748b;">+ ${reasonDisplay}: ₹${additionalCost.toFixed(2)}</span>`;
        }

        const originalPreviousDue = order.previousDue || 0;
        if (originalPreviousDue > 0) {
            confirmText += `<br><span style="font-size:1rem; color:var(--danger-color);">+ Original Previous Due: ₹${originalPreviousDue.toFixed(2)}</span>`;
        }

        let rawNewGrandTotal = itemsTotal + originalPreviousDue + additionalCost;
        let newGrandTotal = rawNewGrandTotal;
        let roundOff = 0;
        if (rawNewGrandTotal % 1 !== 0) {
            newGrandTotal = Math.round(rawNewGrandTotal);
            roundOff = newGrandTotal - rawNewGrandTotal;
        }

        if (Math.abs(roundOff) > 0.001) {
            confirmText += `<br><span style="font-size:1rem; color:#64748b;">Round Off: ₹${roundOff > 0 ? '+' : ''}${roundOff.toFixed(2)}</span>`;
        }

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

    let rawGrandTotal = itemsTotal + previousDue + additionalCost;
    let grandTotal = rawGrandTotal;
    let roundOff = 0;
    if (rawGrandTotal % 1 !== 0) {
        grandTotal = Math.round(rawGrandTotal);
        roundOff = grandTotal - rawGrandTotal;
    }

    document.getElementById('confirmCustomerName').textContent = `Customer: ${currentCustomer.name}`;
    let confirmText = `Items Total: ₹${itemsTotal.toFixed(2)}`;
    if (additionalCost > 0) {
        const reasonDisplay = additionalCostReason ? additionalCostReason : 'Misc';
        confirmText += `<br><span style="font-size:1rem; color:#64748b;">+ ${reasonDisplay}: ₹${additionalCost.toFixed(2)}</span>`;
    }
    if (previousDue > 0) {
        confirmText += `<br><span style="font-size:1rem; color:var(--danger-color);">+ Previous Due: ₹${previousDue.toFixed(2)}</span>`;
    } else if (customerPendingDue > 0 && !shouldIncludePrevDue) {
        confirmText += `<br><span style="font-size:0.9rem; color:#64748b;">(Pending Dues of ₹${customerPendingDue.toFixed(2)} not added to this bill)</span>`;
    }
    if (Math.abs(roundOff) > 0.001) {
        confirmText += `<br><span style="font-size:1rem; color:#64748b;">Round Off: ₹${roundOff > 0 ? '+' : ''}${roundOff.toFixed(2)}</span>`;
    }
    confirmText += `<br><br>Grand Total: ₹${grandTotal.toFixed(2)}`;
    document.getElementById('confirmGrandTotal').innerHTML = confirmText;

    // Reset advance payment fields
    const advanceInput = document.getElementById('advancePaymentAmount');
    if (advanceInput) {
        advanceInput.value = '';
        document.getElementById('advancePaymentMode').value = 'UPI';
    }
    document.getElementById('confirmGrandTotal').dataset.originalHtml = confirmText;
    document.getElementById('confirmGrandTotal').dataset.grandTotal = grandTotal;

    openModal('confirmOrderModal');
}

function toggleConfirmPrevDue(isChecked) {
    if (!currentCustomer) return;
    const itemsTotal = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    const additionalCostAmountInput = document.getElementById('additionalCostAmount');
    const additionalCost = parseFloat(additionalCostAmountInput ? additionalCostAmountInput.value : 0) || 0;
    const additionalCostReasonInput = document.getElementById('additionalCostReason');
    const additionalCostReason = additionalCostReasonInput ? additionalCostReasonInput.value.trim() : '';

    const customerPendingDue = getCustomerTotalDue(currentCustomer);
    const previousDue = isChecked ? customerPendingDue : 0;

    let rawGrandTotal = itemsTotal + previousDue + additionalCost;
    let grandTotal = rawGrandTotal;
    let roundOff = 0;
    if (rawGrandTotal % 1 !== 0) {
        grandTotal = Math.round(rawGrandTotal);
        roundOff = grandTotal - rawGrandTotal;
    }

    let confirmText = `Items Total: ₹${itemsTotal.toFixed(2)}`;
    if (additionalCost > 0) {
        const reasonDisplay = additionalCostReason ? additionalCostReason : 'Misc';
        confirmText += `<br><span style="font-size:1rem; color:#64748b;">+ ${reasonDisplay}: ₹${additionalCost.toFixed(2)}</span>`;
    }
    if (previousDue > 0) {
        confirmText += `<br><span style="font-size:1rem; color:var(--danger-color);">+ Previous Due: ₹${previousDue.toFixed(2)}</span>`;
    } else if (customerPendingDue > 0) {
        confirmText += `<br><span style="font-size:0.9rem; color:#64748b;">(Pending Dues of ₹${customerPendingDue.toFixed(2)} not added to this bill)</span>`;
    }
    if (Math.abs(roundOff) > 0.001) {
        confirmText += `<br><span style="font-size:1rem; color:#64748b;">Round Off: ₹${roundOff > 0 ? '+' : ''}${roundOff.toFixed(2)}</span>`;
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
    const originalText = btn.innerHTML;
    btn.innerHTML = '⏳ Processing...';
    btn.disabled = true;

    // Small delay for interactive feel
    await new Promise(r => setTimeout(r, 400));

    const itemsTotal = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);

    // Calculate the next invoice number
    let nextInvoiceNum = 1001;
    if (orders.length > 0) {
        const numbers = orders.map(o => {
            const parts = o.id.split('_');
            return parts.length >= 3 ? parseInt(parts[2], 10) : 0;
        }).filter(num => !isNaN(num) && num > 0);
        if (numbers.length > 0) {
            nextInvoiceNum = Math.max(...numbers) + 1;
        }
    }
    const newOrderId = 'ord_' + Date.now() + '_' + nextInvoiceNum;

    // Check if user chose to include previous dues on this printed bill
    const includePrevDueCheckbox = document.getElementById('includePreviousDueCheckbox');
    const shouldIncludePrevDue = includePrevDueCheckbox ? includePrevDueCheckbox.checked : false;

    // Customer existing pending dues across all previous orders
    const existingDues = getCustomerTotalDue(currentCustomer);
    const previousDue = shouldIncludePrevDue ? existingDues : 0;

    const additionalCostAmountInput = document.getElementById('additionalCostAmount');
    const additionalCost = parseFloat(additionalCostAmountInput ? additionalCostAmountInput.value : 0) || 0;
    const additionalCostReasonInput = document.getElementById('additionalCostReason');
    const additionalCostReason = additionalCostReasonInput ? additionalCostReasonInput.value.trim() : '';

    let rawGrandTotal = itemsTotal + previousDue + additionalCost;
    let grandTotal = rawGrandTotal;
    if (rawGrandTotal % 1 !== 0) {
        grandTotal = Math.round(rawGrandTotal);
    }

    const advancePaymentInput = document.getElementById('advancePaymentAmount');
    const advanceModeInput = document.getElementById('advancePaymentMode');
    let advanceAmount = 0;
    if (advancePaymentInput) {
        advanceAmount = parseFloat(advancePaymentInput.value || 0);
        if (isNaN(advanceAmount) || advanceAmount < 0) advanceAmount = 0;
    }

    if (advanceAmount > grandTotal && grandTotal > 0) {
        showToast('Payment received cannot be greater than the grand total.');
        btn.innerHTML = originalText;
        btn.disabled = false;
        return;
    }

    // Allocate payment:
    // If previous dues were included, mark all older unadjusted orders as rolled into this new order
    if (shouldIncludePrevDue) {
        const custPastOrders = orders.filter(o => orderBelongsToCustomer(o, currentCustomer) && !isOrderAdjusted(o));
        for (const pastOrder of custPastOrders) {
            pastOrder.adjustedWithOrderId = newOrderId;
            cloudUpsertOrder(pastOrder);
        }
    }

    const affectedOrders = [];
    if (advanceAmount > 0) {
        affectedOrders.push(newOrderId);
    }

    const newOrder = {
        id: newOrderId,
        customerId: currentCustomer.id,
        customerName: currentCustomer.name, // Snapshot name in case customer is later deleted
        customerPhone: currentCustomer.phone || '',
        customerAddress: currentCustomer.address || '',
        items: [...cart],
        itemsTotal: itemsTotal,
        previousDue: previousDue,
        additionalCost: additionalCost,
        additionalCostReason: additionalCostReason,
        totalAmount: grandTotal,
        paidAmount: advanceAmount,
        date: new Date().toISOString()
    };

    // Save to orders & localStorage
    orders.push(newOrder);
    localStorage.setItem('taruchhaya_orders', JSON.stringify(orders));
    // Sync new order to cloud
    cloudUpsertOrder(newOrder);

    // If advance payment > 0, log it in payment history
    if (advanceAmount > 0) {
        const historyRecord = {
            id: 'pay_' + Date.now(),
            customerId: currentCustomer.id,
            customerName: currentCustomer.name,
            amount: advanceAmount,
            mode: advanceModeInput ? advanceModeInput.value : 'UPI',
            date: new Date().toISOString(),
            orderIds: [...new Set(affectedOrders)]
        };
        paymentHistory.push(historyRecord);
        localStorage.setItem('taruchhaya_payments', JSON.stringify(paymentHistory));
        // Sync payment history to cloud
        cloudInsertPayment(historyRecord);
    }

    // Build shareable bill HTML
    const invoiceNum = 'TE-' + nextInvoiceNum;
    const billElement = buildBillHTML(currentCustomer.name, currentCustomer.address, cart, grandTotal, previousDue, advanceAmount, additionalCost, additionalCostReason, invoiceNum);

    // Reset inputs
    if (additionalCostAmountInput) additionalCostAmountInput.value = '';
    if (additionalCostReasonInput) additionalCostReasonInput.value = '';

    // Share or copy as image
    await shareAsImage(billElement, `Bill for ${currentCustomer.name}`);

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
    btn.innerHTML = originalText;
    btn.disabled = false;
}

// --- Edit Bill Logic ---

function startEditBill(orderId) {
    const order = orders.find(o => o.id === orderId);
    if (!order) {
        showToast('Bill not found.', 'error');
        return;
    }

    editingOrderId = orderId;
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

async function propagateOrderTotalChange(orderId, difference) {
    if (difference === 0) return;

    const order = orders.find(o => o.id === orderId);
    if (!order) return;

    if (order.adjustedWithOrderId) {
        const adjustingOrder = orders.find(o => o.id === order.adjustedWithOrderId);
        if (adjustingOrder) {
            adjustingOrder.previousDue = (adjustingOrder.previousDue || 0) + difference;
            adjustingOrder.totalAmount = (adjustingOrder.totalAmount || 0) + difference;

            if (adjustingOrder.adjustedWithOrderId) {
                adjustingOrder.paidAmount = adjustingOrder.totalAmount;
                await propagateOrderTotalChange(adjustingOrder.id, difference);
            }

            await cloudUpsertOrder(adjustingOrder);
        }
    }
}

async function finalizeBillEdits() {
    if (!editingOrderId) return;

    const btn = document.getElementById('saveAndShareBtn');
    const originalText = btn.innerHTML;
    btn.innerHTML = '⏳ Saving...';
    btn.disabled = true;

    // Small delay for interactive feel
    await new Promise(r => setTimeout(r, 400));

    const order = orders.find(o => o.id === editingOrderId);
    if (!order) {
        closeModal('confirmOrderModal');
        btn.innerHTML = originalText;
        btn.disabled = false;
        showToast('Error: Bill not found.', 'error');
        return;
    }

    const itemsTotal = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    const additionalCostAmountInput = document.getElementById('additionalCostAmount');
    const additionalCost = parseFloat(additionalCostAmountInput ? additionalCostAmountInput.value : 0) || 0;
    const additionalCostReasonInput = document.getElementById('additionalCostReason');
    const additionalCostReason = additionalCostReasonInput ? additionalCostReasonInput.value.trim() : '';

    let rawNewGrandTotal = itemsTotal + (order.previousDue || 0) + additionalCost;
    let newGrandTotal = rawNewGrandTotal;
    if (rawNewGrandTotal % 1 !== 0) {
        newGrandTotal = Math.round(rawNewGrandTotal);
    }
    const difference = newGrandTotal - getOrderTotal(order);

    // Update order values
    order.items = [...cart];
    order.itemsTotal = itemsTotal;
    order.additionalCost = additionalCost;
    order.additionalCostReason = additionalCostReason;
    order.totalAmount = newGrandTotal;

    if (order.adjustedWithOrderId) {
        // If adjusted, paidAmount must match totalAmount
        order.paidAmount = newGrandTotal;
    }

    // Propagate changes if there is a difference
    if (difference !== 0) {
        await propagateOrderTotalChange(editingOrderId, difference);
    }

    // Save orders & localStorage
    localStorage.setItem('taruchhaya_orders', JSON.stringify(orders));

    // Sync updated main order to cloud
    await cloudUpsertOrder(order);

    // Build shareable bill HTML
    const invoiceNum = getInvoiceNumber(order);
    const billElement = buildBillHTML(
        currentCustomer.name,
        currentCustomer.address,
        cart,
        newGrandTotal,
        order.previousDue || 0,
        order.paidAmount || 0,
        additionalCost,
        additionalCostReason,
        invoiceNum
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
    btn.innerHTML = originalText;
    btn.disabled = false;

    // Switch view back to bills view
    switchView('billsView');

    showToast('Bill updated successfully!', 'success');
}

// --- Utility: Build bill HTML ---
function buildBillHTML(customerName, customerAddress, items, grandTotal, previousDue = 0, advanceAmount = 0, additionalCost = 0, additionalCostReason = '', invoiceNum = '') {
    const now = new Date();
    const date = now.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const time = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });

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
                ${invoiceNum ? `<p style="margin: 5px 0 0 0; color: #64748b; font-size: 14px;">Invoice No: <strong>${invoiceNum}</strong></p>` : ''}
                <p style="margin: ${invoiceNum ? '3px' : '5px'} 0 0 0; color: #64748b; font-size: 14px;">Date: <strong>${date} ${time}</strong></p>
            </div>
        </div>
        
        <div style="margin-bottom: 30px;">
            <p style="margin: 0; font-size: 14px; color: #64748b;">Billed To:</p>
            <h3 style="margin: 5px 0 0 0; font-size: 18px; color: #1e293b;">${customerName}</h3>
            ${customerAddress ? `<p style="margin: 3px 0 0 0; font-size: 14px; color: #64748b; white-space: pre-wrap;">${customerAddress}</p>` : ''}
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
        let itemAmount = item.price * item.quantity;
        subTotal += itemAmount;
        let amountStr = itemAmount.toFixed(2);
        html += `
            <tr style="border-bottom: 1px solid #f1f5f9;">
                <td style="padding: 12px; font-size: 14px; color: #334155;">${index + 1}</td>
                <td style="padding: 12px; font-size: 14px; color: #334155; font-weight: 500;">${item.name}</td>
                <td style="padding: 12px; text-align: center; font-size: 14px; color: #334155;">${item.quantity}</td>
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
                    <span style="color: #64748b; font-size: 14px;">${reason}</span>
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
                    <span style="color: #0f172a; font-size: 18px; font-weight: 700;">Balance Due</span>
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
async function shareAsImage(element, title) {
    element.style.position = 'absolute';
    element.style.left = '-9999px';
    element.style.top = '-9999px';
    document.body.appendChild(element);

    try {
        if (!window.html2canvas) {
            throw new Error('html2canvas not loaded');
        }
        const canvas = await html2canvas(element, {
            scale: 2, // high res
            backgroundColor: '#ffffff'
        });

        canvas.toBlob(async (blob) => {
            if (!blob) throw new Error('Canvas to Blob failed');
            const file = new File([blob], 'invoice.png', { type: 'image/png' });

            if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
                await navigator.share({
                    title: title,
                    files: [file]
                });
            } else {
                // Fallback: try clipboard write
                try {
                    const item = new ClipboardItem({ 'image/png': blob });
                    await navigator.clipboard.write([item]);
                    showToast('Image copied to clipboard! You can paste it into WhatsApp or other apps.');
                } catch (err) {
                    console.error('Clipboard failed', err);
                    showToast('Could not copy image automatically. You can take a screenshot of the bill.');
                }
            }
        });
    } catch (err) {
        console.error('Image generation failed', err);
        showToast('Failed to generate image. Please make sure you are online to load the image generator script.');
    } finally {
        document.body.removeChild(element);
    }
}

// --- Payments Logic ---
function handlePaymentCustomerChange() {
    return onPaymentCustomerChange();
}

function onPaymentCustomerChange() {
    const custSelect = document.getElementById('paymentCustomerSelect');
    const amountInput = document.getElementById('paymentAmount');
    const invoiceGroup = document.getElementById('paymentInvoiceGroup');
    const dateGroup = document.getElementById('paymentDateGroup');
    const invoiceIdInput = document.getElementById('paymentDisplayInvoiceId');
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
    const targetCust = customers.find(c => String(c.id) === String(customerId)) || { id: customerId };
    const custOrders = orders.filter(o => orderBelongsToCustomer(o, targetCust));
    let totalDue = 0;
    const unpaidOrders = [];

    custOrders.forEach(order => {
        const due = getOrderDue(order);
        if (due > 0) {
            totalDue += due;
            unpaidOrders.push(order);
        }
    });

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
        opt.textContent = c.name;
        custSelect.appendChild(opt);
    });

    const addNewOption = document.createElement('option');
    addNewOption.value = 'add_new';
    addNewOption.textContent = '+ Add New Customer';
    addNewOption.style.fontWeight = 'bold';
    custSelect.appendChild(addNewOption);

    if (orderId) {
        const order = orders.find(o => o.id === orderId);
        if (order) {
            custSelect.value = order.customerId;
            custSelect.disabled = true;
            if (billInput) billInput.value = order.id;

            if (invoiceIdInput) invoiceIdInput.value = getInvoiceNumber(order);
            if (dateInput) dateInput.value = new Date(order.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
            if (invoiceGroup) invoiceGroup.style.display = 'block';
            if (dateGroup) dateGroup.style.display = 'block';

            const pending = getOrderDue(order);
            if (amountInput) amountInput.value = pending > 0 ? pending.toFixed(2) : 0;
        }
    } else {
        custSelect.disabled = false;
        custSelect.value = '';
        if (billInput) billInput.value = '';
        if (invoiceGroup) invoiceGroup.style.display = 'none';
        if (dateGroup) dateGroup.style.display = 'none';
        if (amountInput) amountInput.value = '';
    }

    openModal('paymentModal');
}

function savePayment(e) {
    e.preventDefault();
    const custSelect = document.getElementById('paymentCustomerSelect');
    const billInput = document.getElementById('paymentBillId');
    const amountInput = document.getElementById('paymentAmount');
    const modeSelect = document.getElementById('paymentMode');

    const customerId = custSelect.value || (orders.find(o => o.id === billInput.value) || {}).customerId;
    const orderId = billInput.value;
    const amount = parseFloat(amountInput.value);
    const paymentMode = modeSelect ? modeSelect.value : 'Cash';

    if (isNaN(amount) || amount <= 0) {
        showToast('Invalid amount');
        return;
    }

    const affectedOrders = [];
    const targetCustomer = customers.find(c => String(c.id) === String(customerId)) || { id: customerId };

    if (orderId) {
        const order = orders.find(o => o.id === orderId);
        if (order) {
            const currentPaid = getOrderPaid(order);
            const total = getOrderTotal(order);
            order.paidAmount = Math.min(total, currentPaid + amount);
            affectedOrders.push(orderId);
            // Sync updated order to cloud
            cloudUpsertOrder(order);
        }
    } else {
        if (!customerId) {
            showToast('Select a customer');
            return;
        }
        let remaining = amount;
        const custOrders = orders.filter(o => orderBelongsToCustomer(o, targetCustomer) && !isOrderAdjusted(o)).sort((a, b) => new Date(a.date) - new Date(b.date));

        for (const order of custOrders) {
            if (remaining <= 0) break;
            const pending = getOrderDue(order);
            if (pending > 0) {
                const pay = Math.min(pending, remaining);
                order.paidAmount = getOrderPaid(order) + pay;
                remaining -= pay;
                affectedOrders.push(order.id);
                // Sync updated order to cloud
                cloudUpsertOrder(order);
            }
        }

        if (remaining > 0) {
            showToast(`Payment recorded. ₹${(amount - remaining).toFixed(2)} applied to dues. Excess ₹${remaining.toFixed(2)} recorded in payment history.`);
        }
    }

    // Save payment history
    const historyRecord = {
        id: 'pay_' + Date.now(),
        customerId: customerId,
        customerName: (customers.find(c => String(c.id) === String(customerId)) || {}).name || (targetCustomer ? targetCustomer.name : 'Unknown'),
        amount: amount,
        mode: paymentMode,
        date: new Date().toISOString(),
        orderIds: [...new Set(affectedOrders)]
    };
    paymentHistory.push(historyRecord);
    localStorage.setItem('taruchhaya_payments', JSON.stringify(paymentHistory));
    // Sync payment history to cloud
    cloudInsertPayment(historyRecord);

    localStorage.setItem('taruchhaya_orders', JSON.stringify(orders));
    closeModal('paymentModal');
    
    // Update all views
    renderBills();
    renderPaymentHistory();
    renderCustomersList();
    renderHomeDashboard();
    updateOrderStepUI();
    if (document.getElementById('unpaidModal') && document.getElementById('unpaidModal').classList.contains('active')) {
        showUnpaidModal();
    }
    showToast('Payment recorded successfully!', 'success');
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
        container.innerHTML = `<p style="text-align:center; color:var(--text-secondary); margin-top:20px; font-style:italic;">No customers matching "${query.replace(/"/g, '&quot;')}".</p>`;
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
                <h3 style="margin: 0; font-size: 1.25rem; font-weight: 700; color: #1e293b;">${cust.name}</h3>
                <div style="margin-top: 4px; display: flex; flex-direction: column; gap: 2px;">
                    <span style="font-size: 0.9rem; color: #64748b;">📞 ${cust.phone || 'N/A'}</span>
                    <span style="font-size: 0.9rem; color: #64748b;">Added: ${dateString}</span>
                </div>
            </div>
            
            <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; margin-top: 5px;">
                <span style="color: ${totalDue > 0 ? 'var(--danger-color)' : 'var(--success-color)'}; font-weight: 700; font-size: 1.1rem; flex: 1;">
                    ${totalDue > 0 ? 'Due: ₹' + totalDue.toFixed(2) : 'No Dues'}
                </span>
                
                <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
                    ${totalDue > 0 ? `<button class="btn btn-secondary" style="padding: 4px 10px; font-size: 0.85rem; border-color: var(--success-color); color: var(--success-color); background: transparent; border-radius: 8px; font-weight: 600;" onclick="openPaymentForCustomer('${cust.id}')">💰 Pay</button>` : ''}
                    <button class="btn btn-secondary" style="padding: 4px 12px; font-size: 0.9rem; border-color: var(--accent-color); color: var(--accent-color); background: transparent; border-radius: 8px; display: flex; align-items: center; gap: 4px;" onclick="editCustomer('${cust.id}')">✏️ Edit</button>
                    <button class="btn-danger" style="padding: 4px 8px; font-size: 0.9rem; border: none; background: transparent; display: flex; align-items: center; gap: 4px; cursor: pointer; color: var(--danger-color);" onclick="deleteCustomer('${cust.id}')">🗑️ Delete</button>
                </div>
            </div>
            
            <div style="margin-top: 5px;">
                <button class="btn btn-secondary" style="padding: 6px 16px; font-size: 0.95rem; border-color: var(--accent-color); color: var(--accent-color); background: transparent; border-radius: 8px;" onclick="viewCustomerBills('${cust.name}')">View Bills</button>
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

function viewCustomerBills(customerName) {
    switchView('billsView');
    const billSearchInput = document.getElementById('billSearchInput');
    if (billSearchInput) {
        billSearchInput.value = customerName;
        renderBills();
    }
}

// --- Dashboard Management ---

function renderHomeDashboard() {
    // Basic stats
    let totalRevenue = 0;
    let totalOrders = orders.length;
    let totalCustomersCount = customers.length;

    let totalUnpaid = 0;
    let currentAmount = 0;
    let overdueAmount = 0;

    const now = new Date();

    // Calculate top customer and product stats (this month & overall)
    const customerStatsMonth = {};
    const customerStatsAll = {};
    const productStatsMonth = {};
    const productStatsAll = {};

    orders.forEach(order => {
        // Calculate true net revenue (items total + additional costs) instead of totalAmount (which double-counts previous dues)
        const netSales = (order.itemsTotal || 0) + (order.additionalCost || 0);
        totalRevenue += netSales;

        const due = getOrderDue(order);
        if (due > 0 && !isOrderAdjusted(order)) {
            totalUnpaid += due;
            const orderDate = new Date(order.date);
            const daysOld = (now - orderDate) / (1000 * 60 * 60 * 24);
            if (daysOld > 30) {
                overdueAmount += due;
            } else {
                currentAmount += due;
            }
        }

        const custId = order.customerId;
        const custName = order.customerName || (customers.find(c => orderBelongsToCustomer(order, c)) || {}).name || 'Unknown Customer';
        const orderDate = new Date(order.date);
        const isCurrentMonth = orderDate.getMonth() === now.getMonth() && orderDate.getFullYear() === now.getFullYear();

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
            const prodName = item.name || 'Unknown Product';
            if (!productStatsAll[prodName]) {
                productStatsAll[prodName] = { name: prodName, quantity: 0 };
            }
            productStatsAll[prodName].quantity += (parseFloat(item.quantity) || 0);

            if (isCurrentMonth) {
                if (!productStatsMonth[prodName]) {
                    productStatsMonth[prodName] = { name: prodName, quantity: 0 };
                }
                productStatsMonth[prodName].quantity += (parseFloat(item.quantity) || 0);
            }
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
        unpaidBreakdownEl.textContent = `Cur: ₹${currentAmount.toFixed(2)} | Over: ₹${overdueAmount.toFixed(2)}`;
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
            ? `<p style="text-align:center; color:var(--text-secondary); margin-top:20px; font-style:italic;">No unpaid invoices matching "${query.replace(/"/g, '&quot;')}".</p>`
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
                    <h3 style="margin: 0; font-size: 1.05rem; color: var(--text-color);">${customerName}</h3>
                    <div style="font-size: 0.85rem; color: var(--text-secondary); margin-top: 4px; font-weight: 500;">
                        <span>#${invoiceNum}</span> &bull; <span>${dateStr}</span>
                    </div>
                </div>
                <div style="text-align: right;">
                    <div style="color: var(--danger-color); font-weight: bold; font-size: 1.1rem;">₹${order.dueAmount.toFixed(2)}</div>
                    <button class="btn btn-secondary" style="padding: 4px 10px; font-size: 0.8rem; margin-top: 6px; border-color: var(--accent-color); color: var(--accent-color); background: transparent;" onclick="closeModal('unpaidModal'); openPaymentModal('${order.id}')">Pay Now</button>
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
    const customerStats = {};
    
    orders.forEach(order => {
        if (order.customerId) {
            const orderDate = new Date(order.date);
            if (orderDate.getMonth() === now.getMonth() && orderDate.getFullYear() === now.getFullYear()) {
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
                const netSales = (order.itemsTotal || 0) + (order.additionalCost || 0);
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
                        <h3 style="margin: 0; font-size: 1.05rem; color: var(--text-color);">${cust.name}</h3>
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
    const productStats = {};
    
    orders.forEach(order => {
        const orderDate = new Date(order.date);
        if (orderDate.getMonth() === now.getMonth() && orderDate.getFullYear() === now.getFullYear()) {
            (order.items || []).forEach(item => {
                const prodName = item.name || 'Unknown Product';
                if (!productStats[prodName]) {
                    productStats[prodName] = {
                        name: prodName,
                        quantity: 0
                    };
                }
                productStats[prodName].quantity += item.quantity;
            });
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
                        <h3 style="margin: 0; font-size: 1.05rem; color: var(--text-color);">${prod.name}</h3>
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
            return custName.includes(query) || mode.includes(query) || amountStr.includes(query) || dateStr.includes(query);
        });
    }

    if (filteredHistory.length === 0) {
        container.innerHTML = `<p style="text-align:center; color:var(--text-secondary); margin-top:20px; font-style:italic;">No payment records found matching "${query.replace(/"/g, '&quot;')}".</p>`;
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
        card.innerHTML = `
            <div class="bill-card-header" style="border-bottom: none; padding-bottom: 0;">
                <div>
                    <h3 style="margin:0; font-size:1.05rem; color: var(--text-color);">${pay.customerName}</h3>
                    <span class="bill-date" style="display:block; margin-top:4px;">${dateString} at ${timeString}</span>
                </div>
                <div style="text-align: right;">
                    <span style="display:block; color:var(--success-color); font-weight:bold; font-size:1.1rem;">+ ₹${pay.amount.toFixed(2)}</span>
                    <span style="font-size:0.8rem; color:var(--text-secondary); background:var(--panel-border); padding:2px 6px; border-radius:4px; margin-top:4px; display:inline-block;">${pay.mode}</span>
                </div>
            </div>
        `;
        container.appendChild(card);
    });
}

function viewPaymentBill(paymentId) {
    const pay = paymentHistory.find(p => p.id === paymentId);
    if (!pay) return;

    let targetOrderId = null;
    if (pay.orderIds && pay.orderIds.length > 0) {
        targetOrderId = pay.orderIds[pay.orderIds.length - 1];
    } else {
        const custOrders = orders.filter(o => o.customerId === pay.customerId && new Date(o.date) <= new Date(pay.date));
        if (custOrders.length > 0) {
            targetOrderId = custOrders[custOrders.length - 1].id;
        }
    }

    if (targetOrderId) {
        showBillPreviewModal(targetOrderId);
    } else {
        showToast('No specific bill found for this payment.');
    }
}

function showBillPreviewModal(orderId) {
    const order = orders.find(o => o.id === orderId);
    if (!order) return;

    const customer = customers.find(c => c.id === order.customerId) || {};
    const customerName = order.customerName || customer.name || 'Customer';
    const customerAddress = order.customerAddress || customer.address || '';
    const invoiceNum = getInvoiceNumber(order);
    const billElement = buildBillHTML(customerName, customerAddress, order.items, order.totalAmount, order.previousDue || 0, order.paidAmount || 0, order.additionalCost || 0, order.additionalCostReason || '', invoiceNum);

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

    if (orders.length === 0) {
        container.innerHTML = '<p style="text-align:center; color:var(--text-secondary); margin-top:20px; font-style:italic;">No bills saved yet.</p>';
        return;
    }

    const searchInput = document.getElementById('billSearchInput');
    const query = searchInput ? searchInput.value.trim().toLowerCase() : '';

    // Filter orders based on query and current tab filter
    let filteredOrders = orders;

    if (currentBillsFilter === 'unpaid') {
        filteredOrders = filteredOrders.filter(o => getOrderDue(o) > 0 && !isOrderAdjusted(o));
    } else if (currentBillsFilter === 'paid') {
        filteredOrders = filteredOrders.filter(o => getOrderDue(o) <= 0 || isOrderAdjusted(o));
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
        let emptyMsg = `No bills found matching "${query.replace(/"/g, '&quot;')}".`;
        if (!query) {
            if (currentBillsFilter === 'unpaid') emptyMsg = '🎉 No unpaid bills found! All bills are fully paid.';
            else if (currentBillsFilter === 'paid') emptyMsg = 'No fully paid bills yet.';
        }
        container.innerHTML = `<p style="text-align:center; color:var(--text-secondary); margin-top:20px; font-style:italic;">${emptyMsg}</p>`;
        return;
    }

    // Show newest orders first
    const sortedOrders = [...filteredOrders].reverse();

    // Group by customer
    const groupedOrders = {};
    sortedOrders.forEach(order => {
        const customerName = order.customerName ||
            (customers.find(c => orderBelongsToCustomer(order, c)) || {}).name ||
            'Unknown Customer';

        if (!groupedOrders[customerName]) {
            groupedOrders[customerName] = [];
        }
        groupedOrders[customerName].push(order);
    });

    // Priority sorting for customer folders: Newest bill date first -> Alphabetical
    const folderKeys = Object.keys(groupedOrders).sort((a, b) => {
        const ordersA = groupedOrders[a];
        const ordersB = groupedOrders[b];

        const maxDateA = Math.max(...ordersA.map(o => new Date(o.date).getTime()));
        const maxDateB = Math.max(...ordersB.map(o => new Date(o.date).getTime()));

        if (maxDateA !== maxDateB) return maxDateB - maxDateA;
        return a.localeCompare(b);
    });

    folderKeys.forEach((customerName, index) => {
        // Ensure bills inside each folder are sorted newest first
        const customerOrders = [...groupedOrders[customerName]].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

        let totalDue = 0;
        customerOrders.forEach(order => {
            if (!isOrderAdjusted(order)) {
                totalDue += getOrderDue(order);
            }
        });

        const folderDiv = document.createElement('div');
        folderDiv.className = 'customer-folder';

        const folderId = 'folder-' + customerName.replace(/[^a-zA-Z0-9]/g, '-');

        // Auto-expand the very top folder or expand all if search query is active or unpaid filter is on
        const shouldExpand = index === 0 || query.length > 0 || currentBillsFilter === 'unpaid';

        // Folder Header
        const folderHeader = document.createElement('div');
        folderHeader.className = 'customer-folder-header';
        folderHeader.onclick = () => toggleFolder(folderId);
        folderHeader.innerHTML = `
            <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
                <h3>📁 ${customerName}</h3>
                <span class="folder-badge">${customerOrders.length} Bill${customerOrders.length > 1 ? 's' : ''}</span>
                ${totalDue > 0 ? `<span style="font-size:0.85rem; color:var(--danger-color); font-weight:bold; border: 1px solid var(--danger-color); padding: 2px 6px; border-radius: 4px;">Due: ₹${totalDue.toFixed(2)}</span>` : `<span style="font-size:0.85rem; color:var(--success-color); font-weight:bold;">All Paid</span>`}
            </div>
            <span class="folder-icon" id="icon-${folderId}">${shouldExpand ? '▲' : '▼'}</span>
        `;

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
                itemsHtml += `<li><span>${item.name} × ${item.quantity}</span><span>₹${((parseFloat(item.price) || 0) * (parseFloat(item.quantity) || 0)).toFixed(2)}</span></li>`;
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
                    ${pending > 0 ? `<button class="btn btn-secondary full-width" style="margin-top:8px; font-size:0.85rem; padding:6px; border-color:var(--success-color); color:var(--success-color); font-weight:600;" onclick="openPaymentModal('${order.id}')">💰 Record Payment</button>` : `<div style="text-align:center; color:var(--success-color); font-size:0.85rem; margin-top:8px; font-weight:600;">✅ Fully Paid</div>`}
                `;
            }

            const invoiceNum = getInvoiceNumber(order);
            billCard.innerHTML = `
                <div class="bill-card-header">
                    <div>
                        <div style="font-weight: 700; color: var(--accent-color); font-size: 0.95rem; margin-bottom: 2px;"># ${invoiceNum}</div>
                        <span class="bill-date">${dateString}</span>
                    </div>
                    <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                        <button class="btn btn-secondary share-bill-btn" onclick="startEditBill('${order.id}')" title="Edit this bill">✏️ Edit</button>
                        <button class="btn btn-secondary share-bill-btn" onclick="shareBill('${order.id}')" title="Share this bill">📤 Share</button>
                        <button class="btn btn-primary share-bill-btn" onclick="printInvoice('${order.id}')" title="Print Invoice">🖨️ Print</button>
                        <button class="btn btn-danger share-bill-btn" style="padding: 0.4rem; min-width: unset;" onclick="deleteBill('${order.id}')" title="Delete Bill">🗑️</button>
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

function shareBill(orderId) {
    const order = orders.find(o => o.id === orderId);
    if (!order) {
        showToast('Bill not found.');
        return;
    }

    const customer = customers.find(c => c.id === order.customerId) || {};
    const customerName = order.customerName || customer.name || 'Customer';
    const customerAddress = order.customerAddress || customer.address || '';

    const invoiceNum = getInvoiceNumber(order);
    const billElement = buildBillHTML(customerName, customerAddress, order.items, order.totalAmount, order.previousDue || 0, order.paidAmount || 0, order.additionalCost || 0, order.additionalCostReason || '', invoiceNum);
    shareAsImage(billElement, `Bill for ${customerName}`);
}

function printInvoice(orderId) {
    const order = orders.find(o => o.id === orderId);
    if (!order) return;

    const customer = customers.find(c => c.id === order.customerId) || {};
    const customerName = order.customerName || customer.name || 'Customer';
    const customerAddress = order.customerAddress || customer.address || '';
    const customerPhone = order.customerPhone || customer.phone || '';

    const dateObj = new Date(order.date);
    const dateString = dateObj.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' });

    const paid = order.paidAmount || 0;
    const balanceDue = order.totalAmount - paid;

    let itemsHtml = '';
    order.items.forEach((item, index) => {
        const unitStr = item.unit ? ` ${item.unit}` : '';
        itemsHtml += `
            <tr>
                <td style="padding: 12px 15px; border-bottom: 1px solid #eee;">${index + 1}</td>
                <td style="padding: 12px 15px; border-bottom: 1px solid #eee;"><strong>${item.name}</strong></td>
                <td style="padding: 12px 15px; border-bottom: 1px solid #eee; text-align: center;">${item.quantity}${unitStr}</td>
                <td style="padding: 12px 15px; border-bottom: 1px solid #eee; text-align: right;">₹ ${item.price.toFixed(2)}</td>
                <td style="padding: 12px 15px; border-bottom: 1px solid #eee; text-align: right;">₹ ${(item.price * item.quantity).toFixed(2)}</td>
            </tr>
        `;
    });

    const invoiceNum = getInvoiceNumber(order);
    const subTotal = order.itemsTotal || (order.items || []).reduce((s, i) => s + (i.price * i.quantity), 0);
    const printWindow = window.open('', '', 'width=800,height=900');
    printWindow.document.write(`
    <html>
    <head>
        <title>Invoice - ${invoiceNum} - ${customerName}</title>
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
                    <div class="balance-label">Balance Due</div>
                    <div class="balance-amount">₹ ${balanceDue.toFixed(2)}</div>
                </div>
            </div>
        </div>

        <div class="info-section">
            <div class="bill-to">
                <h3>Bill To</h3>
                <strong>${customerName}</strong><br>
                ${customerAddress ? `${customerAddress.replace(/\\n/g, '<br>')}<br>` : ''}
                Customer ID: ${order.customerId}<br>
            </div>
            <div>
                <table class="meta-table">
                    <tr><td>Invoice No :</td><td><strong>${invoiceNum}</strong></td></tr>
                    <tr><td>Invoice Date :</td><td>${dateString}</td></tr>
                    <tr><td>Terms :</td><td>Due On Receipt</td></tr>
                    <tr><td>Due Date :</td><td>${dateString}</td></tr>
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
                <span>${order.additionalCostReason || 'Extra Charges'}</span>
                <span>₹ ${order.additionalCost.toFixed(2)}</span>
            </div>` : ''}
            ${order.previousDue ? `
            <div class="totals-row">
                <span>Previous Due</span>
                <span>₹ ${order.previousDue.toFixed(2)}</span>
            </div>` : ''}
            <div class="totals-row bold" style="margin-top: 10px; border-top: 1px solid #ddd; padding-top: 10px;">
                <span>Total</span>
                <span>₹ ${order.totalAmount.toFixed(2)}</span>
            </div>
            ${paid > 0 ? `
            <div class="totals-row" style="color: #10b981;">
                <span>Paid</span>
                <span>-₹ ${paid.toFixed(2)}</span>
            </div>` : ''}
            <div class="balance-due-row">
                <span>Balance Due</span>
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
}

function deleteBill(orderId) {
    const order = orders.find(o => o.id === orderId);
    if (!order) return;

    const customerName = order.customerName ||
        (customers.find(c => c.id === order.customerId) || {}).name ||
        'Customer';
    const dateObj = new Date(order.date);
    const dateString = dateObj.toLocaleDateString('en-IN');

    showCustomConfirm(`Are you sure you want to delete the bill for ${customerName} dated ${dateString}?`).then(confirmed => {
        if (!confirmed) return;

        // Restore any old orders that were marked as adjusted with this deleted order
        orders.forEach(o => {
            if (o.adjustedWithOrderId === orderId) {
                o.adjustedWithOrderId = null;
                // Reset paidAmount back to 0 if it was auto-marked paid during rollover
                o.paidAmount = 0;
                cloudUpsertOrder(o);
            }
        });

        orders = orders.filter(o => o.id !== orderId);
        localStorage.setItem('taruchhaya_orders', JSON.stringify(orders));

        // Sync delete to cloud
        if (typeof cloudDeleteOrder === 'function') {
            cloudDeleteOrder(orderId);
        }

        renderBills();
        if (typeof renderHomeDashboard === 'function') renderHomeDashboard();
        showToast('Bill deleted successfully');
    });
}

// --- Logout ---
function logout() {
    localStorage.removeItem('taruchhaya_loggedIn');
    window.location.href = 'login.html';
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
    toast.innerHTML = `<span class="toast-icon">${icon}</span> <span>${message}</span>`;

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



