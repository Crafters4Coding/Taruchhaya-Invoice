// --- Authentication Check ---
if (sessionStorage.getItem('taruchhaya_loggedIn') !== 'true') {
    window.location.href = 'login.html';
}

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
                const mapCust = localCust.map(c => ({ id: c.id, name: c.name, phone: c.phone || '', created_at: c.createdAt || new Date().toISOString() }));
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

        // If cloud database has data, it becomes the source of truth
        customers = dbCust.map(r => ({
            id: r.id,
            name: r.name,
            phone: r.phone || '',
            createdAt: r.created_at
        }));

        products = dbProd.map(r => ({
            id: r.id,
            name: r.name,
            price: parseFloat(r.price),
            unit: r.unit || 'pcs'
        }));

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

        paymentHistory = dbPay.map(r => ({
            id: r.id,
            customerId: r.customer_id,
            customerName: r.customer_name || '',
            amount: parseFloat(r.amount || 0),
            mode: r.mode || 'Cash',
            date: r.date
        }));

        // Remove mock data if it exists
        customers = customers.filter(c => c.id !== 'cust_1' && c.id !== 'cust_2');
        products = products.filter(p => p.id !== 'prod_1' && p.id !== 'prod_2' && p.id !== 'prod_3');

        // Cache back to local storage
        localStorage.setItem('taruchhaya_customers', JSON.stringify(customers));
        localStorage.setItem('taruchhaya_products', JSON.stringify(products));
        localStorage.setItem('taruchhaya_orders', JSON.stringify(orders));
        localStorage.setItem('taruchhaya_payments', JSON.stringify(paymentHistory));

        // Re-render UI
        renderCustomerSelect();
        renderProductSelect();
        renderExistingProductsList();
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
        showToast('Connected to Cloud');
    } catch (err) {
        console.error('Failed to load Supabase cloud data:', err);
        updateCloudStatus('error', err.message || 'Check connection/credentials');
    }
}

async function cloudUpsertCustomer(customer) {
    if (!supabaseClient) return;
    try {
        const { error } = await supabaseClient.from('customers').upsert({
            id: customer.id,
            name: customer.name,
            phone: customer.phone || '',
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
    renderExistingProductsList();
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

    const name = nameInput.value.trim();
    if (!name) return;

    if (editingCustomerId) {
        const customer = customers.find(c => c.id === editingCustomerId);
        if (customer) {
            customer.name = name;
            customer.phone = phoneInput.value.trim();
            // Sync edited customer to cloud
            cloudUpsertCustomer(customer);
        }
    } else {
        const newCustomer = {
            id: 'cust_' + Date.now(),
            name: name,
            phone: phoneInput.value.trim(),
            createdAt: new Date().toISOString()
        };
        customers.push(newCustomer);
        // Sync new customer to cloud
        cloudUpsertCustomer(newCustomer);
        setTimeout(() => {
            document.getElementById('customerSelect').value = newCustomer.id;
            handleCustomerChange();
        }, 50);
    }

    localStorage.setItem('taruchhaya_customers', JSON.stringify(customers));

    renderCustomerSelect();
    if (typeof renderCustomersList === 'function') {
        renderCustomersList();
    }
    closeModal('customerModal');
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
        const select = document.getElementById('customerSelect');
        if (select) select.value = '';
        const productSection = document.getElementById('productSection');
        if (productSection) {
            productSection.style.opacity = '0.5';
            productSection.style.pointerEvents = 'none';
        }
        // Also clear cart just in case
        cart = [];
        if (typeof renderCart === 'function') renderCart();
    }

    if (typeof renderCustomerSelect === 'function') renderCustomerSelect();
    if (typeof renderCustomersList === 'function') renderCustomersList();
    showToast('Customer deleted successfully.', 'success');
    });
}

function renderCustomerSelect(filterTerm = '') {
    const select = document.getElementById('customerSelect');
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
    select.size = 1; // Reset size if it was expanded
    const newSelectedId = select.value;
    const productSection = document.getElementById('productSection');

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
        productSection.style.opacity = '1';
        productSection.style.pointerEvents = 'auto';
    } else {
        currentCustomer = null;
        productSection.style.opacity = '0.5';
        productSection.style.pointerEvents = 'none';
    }
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
        editingProductId = null;
        const title = document.querySelector('#productModal h2');
        if (title) title.textContent = 'Add New Product';
        const btn = document.querySelector('#productForm button[type="submit"]');
        if (btn) btn.textContent = 'Save Product';
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
    renderExistingProductsList();

    nameInput.value = '';
    priceInput.value = '';
    if (unitInput) unitInput.value = 'pcs';
    // Don't close modal — allow adding multiple products
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
    renderExistingProductsList();
}

function renderProductSelect(filterTerm = '') {
    const select = document.getElementById('productSelect');
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
}

function renderExistingProductsList() {
    const list = document.getElementById('existingProductsList');
    list.innerHTML = '';

    if (products.length === 0) {
        list.innerHTML = '<li style="color: var(--text-secondary); justify-content: center;">No products added yet.</li>';
        return;
    }

    const sorted = [...products].sort((a, b) => a.name.localeCompare(b.name));

    sorted.forEach(prod => {
        const li = document.createElement('li');
        const unitDisplay = prod.unit ? `<span style="font-size:0.8rem; color:var(--text-secondary); margin-left:4px;">/${prod.unit}</span>` : '';
        li.innerHTML = `
            <span>${prod.name}</span>
            <span style="display:flex; align-items:center; gap:12px;">
                <span style="color: var(--success-color); font-weight:600;">₹${prod.price.toFixed(2)}${unitDisplay}</span>
                <button class="btn btn-secondary" onclick="editProduct('${prod.id}')" title="Edit product" style="padding:2px 6px; font-size:0.8rem;">✏️</button>
                <button class="btn btn-danger" onclick="deleteProduct('${prod.id}')" title="Delete product" style="padding:2px 6px; font-size:0.8rem;">✕</button>
            </span>
        `;
        list.appendChild(li);
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

    // If already in cart, increase quantity
    const existingItem = cart.find(item => item.productId === productId);

    if (existingItem) {
        existingItem.quantity += quantity;
    } else {
        cart.push({
            productId: product.id,
            name: product.name,
            price: product.price,
            quantity: quantity,
            unit: product.unit || 'pcs'
        });
    }

    // Reset inputs
    select.value = '';
    qtyInput.value = '1';

    renderCart();
}

function removeFromCart(productId) {
    cart = cart.filter(item => item.productId !== productId);
    renderCart();
}

function updateCartQuantity(productId, newQty) {
    const qty = parseInt(newQty, 10);
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

function renderCart() {
    const tbody = document.getElementById('cartBody');
    const emptyMsg = document.getElementById('emptyCartMessage');
    const placeOrderBtn = document.getElementById('placeOrderBtn');
    const grandTotalElement = document.getElementById('grandTotalValue');

    tbody.innerHTML = '';
    let grandTotal = 0;

    if (cart.length === 0) {
        emptyMsg.style.display = 'block';
        placeOrderBtn.disabled = true;
        grandTotalElement.textContent = '₹0.00';
        return;
    }

    emptyMsg.style.display = 'none';
    placeOrderBtn.disabled = !currentCustomer; // Only enable if customer is selected

    cart.forEach(item => {
        const itemTotal = item.price * item.quantity;
        grandTotal += itemTotal;

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td style="padding-right: 10px;">${item.name}</td>
            <td style="padding-right: 10px;">
                <div style="display: flex; align-items: center; gap: 4px;">
                    <input type="number" min="1" value="${item.quantity}"
                        style="width:55px; padding:4px; font-size:0.9rem; text-align: center; border: 1px solid var(--panel-border); border-radius: 4px;"
                        onchange="updateCartQuantity('${item.productId}', this.value)"
                        onblur="updateCartQuantity('${item.productId}', this.value)">
                    <span style="font-size: 0.75rem; color: var(--text-secondary);">${item.unit || 'pcs'}</span>
                </div>
            </td>
            <td style="padding-right: 10px;">
                <div style="display: flex; align-items: center; gap: 4px;">
                    <span style="color: var(--text-secondary); font-weight: 500;">₹</span>
                    <input type="number" min="0" step="0.01" value="${item.price.toFixed(2)}"
                        style="width:75px; padding:4px; font-size:0.9rem; border: 1px solid var(--panel-border); border-radius: 4px;"
                        onchange="updateCartPrice('${item.productId}', this.value)"
                        onblur="updateCartPrice('${item.productId}', this.value)">
                </div>
            </td>
            <td style="font-weight: 600; padding-right: 10px;">₹${itemTotal.toFixed(2)}</td>
            <td>
                <button class="btn btn-danger" onclick="removeFromCart('${item.productId}')" title="Remove" style="padding: 4px 8px;">✕</button>
            </td>
        `;
        tbody.appendChild(tr);
    });

    let previousDue = 0;
    if (currentCustomer) {
        orders.filter(o => o.customerId === currentCustomer.id).forEach(order => {
            previousDue += (order.totalAmount - (order.paidAmount || 0));
        });
    }

    const additionalCostAmountInput = document.getElementById('additionalCostAmount');
    const additionalCost = parseFloat(additionalCostAmountInput ? additionalCostAmountInput.value : 0) || 0;
    const additionalCostReasonInput = document.getElementById('additionalCostReason');
    const additionalCostReason = additionalCostReasonInput ? additionalCostReasonInput.value.trim() : '';

    const finalTotal = grandTotal + previousDue + additionalCost;

    if (previousDue > 0 || additionalCost > 0) {
        let totalHtml = `<div style="font-size: 0.9rem; font-weight: normal; color: var(--text-secondary); text-align: right; line-height: 1.4;">Items: ₹${grandTotal.toFixed(2)}`;
        if (additionalCost > 0) {
            const reasonDisplay = additionalCostReason ? additionalCostReason : 'Misc';
            totalHtml += `<br>${reasonDisplay}: ₹${additionalCost.toFixed(2)}`;
        }
        if (previousDue > 0) {
            totalHtml += `<br><span style="color:var(--danger-color)">Prev Due: ₹${previousDue.toFixed(2)}</span>`;
        }
        totalHtml += `</div><div>₹${finalTotal.toFixed(2)}</div>`;
        grandTotalElement.innerHTML = totalHtml;
    } else {
        grandTotalElement.textContent = `₹${finalTotal.toFixed(2)}`;
    }
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

    let previousDue = 0;
    orders.filter(o => o.customerId === currentCustomer.id).forEach(order => {
        previousDue += (order.totalAmount - (order.paidAmount || 0));
    });

    const additionalCostAmountInput = document.getElementById('additionalCostAmount');
    const additionalCost = parseFloat(additionalCostAmountInput ? additionalCostAmountInput.value : 0) || 0;
    const additionalCostReasonInput = document.getElementById('additionalCostReason');
    const additionalCostReason = additionalCostReasonInput ? additionalCostReasonInput.value.trim() : '';

    const grandTotal = itemsTotal + previousDue + additionalCost;

    document.getElementById('confirmCustomerName').textContent = `Customer: ${currentCustomer.name}`;
    let confirmText = `Items Total: ₹${itemsTotal.toFixed(2)}`;
    if (additionalCost > 0) {
        const reasonDisplay = additionalCostReason ? additionalCostReason : 'Misc';
        confirmText += `<br><span style="font-size:1rem; color:#64748b;">+ ${reasonDisplay}: ₹${additionalCost.toFixed(2)}</span>`;
    }
    if (previousDue > 0) {
        confirmText += `<br><span style="font-size:1rem; color:var(--danger-color);">+ Previous Due: ₹${previousDue.toFixed(2)}</span>`;
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
    const newOrderId = 'ord_' + Date.now();

    let previousDue = 0;
    orders.filter(o => o.customerId === currentCustomer.id).forEach(order => {
        const pending = order.totalAmount - (order.paidAmount || 0);
        if (pending > 0) {
            previousDue += pending;
            order.paidAmount = order.totalAmount; // Mark as paid/adjusted
            order.adjustedWithOrderId = newOrderId;
            // Sync adjusted order to cloud
            cloudUpsertOrder(order);
        }
    });

    const additionalCostAmountInput = document.getElementById('additionalCostAmount');
    const additionalCost = parseFloat(additionalCostAmountInput ? additionalCostAmountInput.value : 0) || 0;
    const additionalCostReasonInput = document.getElementById('additionalCostReason');
    const additionalCostReason = additionalCostReasonInput ? additionalCostReasonInput.value.trim() : '';

    const grandTotal = itemsTotal + previousDue + additionalCost;

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

    const newOrder = {
        id: newOrderId,
        customerId: currentCustomer.id,
        customerName: currentCustomer.name, // Snapshot name in case customer is later deleted
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
            date: new Date().toISOString()
        };
        paymentHistory.push(historyRecord);
        localStorage.setItem('taruchhaya_payments', JSON.stringify(paymentHistory));
        // Sync payment history to cloud
        cloudInsertPayment(historyRecord);
    }

    // Build shareable bill text
    const billText = buildBillText(currentCustomer.name, cart, grandTotal, previousDue, advanceAmount, additionalCost, additionalCostReason);
    
    // Reset inputs
    if (additionalCostAmountInput) additionalCostAmountInput.value = '';
    if (additionalCostReasonInput) additionalCostReasonInput.value = '';

    // Share or copy as image
    await shareAsImage(billText, `Bill for ${currentCustomer.name}`);

    // Reset UI
    cart = [];
    currentCustomer = null;

    document.getElementById('customerSelect').value = '';
    document.getElementById('productSection').style.opacity = '0.5';
    document.getElementById('productSection').style.pointerEvents = 'none';

    renderCart();
    renderBills();

    closeModal('confirmOrderModal');
    btn.innerHTML = originalText;
    btn.disabled = false;
}

// --- Utility: Build bill text ---
function buildBillText(customerName, items, grandTotal, previousDue = 0, advanceAmount = 0, additionalCost = 0, additionalCostReason = '') {
    const date = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' });

    // Use triple backticks for monospace formatting in WhatsApp
    let text = "```\n";
    text += "                     INVOICE\n";
    text += "=================================================\n";
    text += "Taruchhaya Enterprise\n";
    text += "Hat-Tola Road, Pandui, Puncha, Purulia - 723151\n";
    text += "-------------------------------------------------\n";
    text += `Bill To: ${customerName}\n`;
    text += `Date   : ${date}\n`;
    text += "=================================================\n";

    // Table Header
    text += "#  Item                    Qty     Rate   Amount\n";
    text += "-------------------------------------------------\n";

    // Items
    items.forEach((item, index) => {
        let idx = (index + 1).toString().padEnd(2);
        let name = item.name.length > 24 ? item.name.substring(0, 21) + '...' : item.name.padEnd(24);
        let qty = item.quantity.toString().padStart(3);
        let rate = item.price.toFixed(2).padStart(8);
        let amount = (item.price * item.quantity).toFixed(2).padStart(9);

        text += `${idx} ${name} ${qty} ${rate} ${amount}\n`;
    });
    text += "-------------------------------------------------\n";

    // Totals
    const subTotal = grandTotal - previousDue - additionalCost;
    text += `Sub Total       : ${subTotal.toFixed(2).padStart(20)}\n`;

    if (additionalCost > 0) {
        let reason = additionalCostReason ? additionalCostReason.substring(0, 15) : 'Misc. Cost';
        text += `${reason.padEnd(16)}: ${additionalCost.toFixed(2).padStart(20)}\n`;
    }

    if (previousDue > 0) {
        text += `Previous Due    : ${previousDue.toFixed(2).padStart(20)}\n`;
    }

    text += `Total           : ${grandTotal.toFixed(2).padStart(20)}\n`;
    
    if (advanceAmount > 0) {
        text += `Payment Received: ${advanceAmount.toFixed(2).padStart(20)}\n`;
    }
    
    const balanceDue = grandTotal - advanceAmount;
    text += "=================================================\n";
    text += `BALANCE DUE     : ₹ ${balanceDue.toFixed(2).padStart(18)}\n`;
    text += "=================================================\n";
    text += "            Thanks for your business.\n";
    text += "       Generated under Taruchhaya Systems\n";
    text += "```";

    return text;
}

// --- Utility: Share text as Image ---
async function shareAsImage(text, title) {
    // Strip backticks from text for display
    const cleanText = text.replace(/```/g, '');
    
    // Create an off-screen container
    const container = document.createElement('div');
    container.style.position = 'absolute';
    container.style.left = '-9999px';
    container.style.top = '-9999px';
    
    // Style it exactly like the requested image but larger font
    const pre = document.createElement('pre');
    pre.textContent = cleanText;
    pre.style.fontFamily = "'Fira Code', 'Courier New', monospace";
    pre.style.fontSize = '24px'; // Increased size
    pre.style.fontWeight = '500';
    pre.style.backgroundColor = '#e6ffd9'; // Light green background
    pre.style.color = '#004d00';
    pre.style.padding = '40px';
    pre.style.margin = '0';
    pre.style.lineHeight = '1.5';
    
    container.appendChild(pre);
    document.body.appendChild(container);
    
    try {
        if (!window.html2canvas) {
            throw new Error('html2canvas not loaded');
        }
        const canvas = await html2canvas(pre, {
            scale: 2, // high res
            backgroundColor: '#e6ffd9'
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
                } catch(err) {
                    console.error('Clipboard failed', err);
                    showToast('Could not copy image automatically. You can take a screenshot of the bill.');
                }
            }
        });
    } catch(err) {
        console.error('Image generation failed', err);
        showToast('Failed to generate image. Please make sure you are online to load the image generator script.');
    } finally {
        document.body.removeChild(container);
    }
}

// --- Payments Logic ---
function handlePaymentCustomerChange() {
    const custSelect = document.getElementById('paymentCustomerSelect');
    const amountInput = document.getElementById('paymentAmount');

    if (custSelect.value === 'add_new') {
        openModal('customerModal');
        custSelect.value = '';
        amountInput.value = '';
        return;
    }

    if (!custSelect.value) {
        amountInput.value = '';
        return;
    }

    const customerId = custSelect.value;
    const custOrders = orders.filter(o => o.customerId === customerId);
    let totalDue = 0;

    custOrders.forEach(order => {
        totalDue += (order.totalAmount - (order.paidAmount || 0));
    });

    amountInput.value = totalDue > 0 ? totalDue.toFixed(2) : '';
}

function openPaymentModal(orderId = null) {
    const custSelect = document.getElementById('paymentCustomerSelect');
    const billGroup = document.getElementById('paymentBillGroup');
    const billInput = document.getElementById('paymentBillId');
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
            billGroup.style.display = 'block';
            billInput.value = order.id;
            const pending = order.totalAmount - (order.paidAmount || 0);
            amountInput.value = pending > 0 ? pending.toFixed(2) : 0;
        }
    } else {
        custSelect.disabled = false;
        custSelect.value = '';
        billGroup.style.display = 'none';
        billInput.value = '';
        amountInput.value = '';
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

    if (orderId) {
        const order = orders.find(o => o.id === orderId);
        if (order) {
            order.paidAmount = (order.paidAmount || 0) + amount;
            // Sync updated order to cloud
            cloudUpsertOrder(order);
        }
    } else {
        if (!customerId) {
            showToast('Select a customer');
            return;
        }
        let remaining = amount;
        const custOrders = orders.filter(o => o.customerId === customerId).sort((a, b) => new Date(a.date) - new Date(b.date));

        for (const order of custOrders) {
            if (remaining <= 0) break;
            const pending = order.totalAmount - (order.paidAmount || 0);
            if (pending > 0) {
                const pay = Math.min(pending, remaining);
                order.paidAmount = (order.paidAmount || 0) + pay;
                remaining -= pay;
                // Sync updated order to cloud
                cloudUpsertOrder(order);
            }
        }

        if (remaining > 0) {
            showToast(`Payment recorded. ₹${remaining.toFixed(2)} was overpaid (no pending bills for this customer).`);
        }
    }

    // Save payment history
    const historyRecord = {
        id: 'pay_' + Date.now(),
        customerId: customerId,
        customerName: (customers.find(c => c.id === customerId) || {}).name || 'Unknown',
        amount: amount,
        mode: paymentMode,
        date: new Date().toISOString()
    };
    paymentHistory.push(historyRecord);
    localStorage.setItem('taruchhaya_payments', JSON.stringify(paymentHistory));
    // Sync payment history to cloud
    cloudInsertPayment(historyRecord);

    localStorage.setItem('taruchhaya_orders', JSON.stringify(orders));
    closeModal('paymentModal');
    renderBills();
    renderPaymentHistory();
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

    const sortedCustomers = [...customers].sort((a, b) => a.name.localeCompare(b.name));

    sortedCustomers.forEach(cust => {
        let totalDue = 0;
        const custOrders = orders.filter(o => o.customerId === cust.id);
        custOrders.forEach(order => {
            totalDue += (order.totalAmount - (order.paidAmount || 0));
        });

        const d = new Date(cust.createdAt || Date.now());
        const dateString = d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

        const card = document.createElement('div');
        card.className = 'bill-card';
        card.style.marginBottom = '10px';
        card.innerHTML = `
            <div class="bill-card-header" style="border-bottom: none; padding-bottom: 0;">
                <div>
                    <h3 style="margin:0; font-size:1.05rem; color: var(--text-color);">${cust.name}</h3>
                    <span class="bill-date" style="display:block; margin-top:4px;">📞 ${cust.phone || 'N/A'}</span>
                    <span class="bill-date" style="display:block; margin-top:4px;">Added: ${dateString}</span>
                </div>
                <div style="text-align: right;">
                    <span style="display:block; color:${totalDue > 0 ? 'var(--danger-color)' : 'var(--success-color)'}; font-weight:bold; font-size:1rem;">
                        ${totalDue > 0 ? 'Due: ₹' + totalDue.toFixed(2) : 'No Dues'}
                    </span>
                    <button class="btn btn-secondary" style="padding: 4px 8px; font-size: 0.8rem; margin-top: 8px;" onclick="editCustomer('${cust.id}')">✏️ Edit</button>
                    <button class="btn btn-danger" style="padding: 4px 8px; font-size: 0.8rem; margin-top: 8px;" onclick="deleteCustomer('${cust.id}')">🗑️ Delete</button>
                    <button class="btn btn-secondary" style="padding: 4px 8px; font-size: 0.8rem; margin-top: 8px;" onclick="switchView('billsView')">View Bills</button>
                </div>
            </div>
        `;
        container.appendChild(card);
    });
}

// --- Dashboard Management ---
let cashFlowChartInstance = null;

function renderHomeDashboard() {
    // Basic stats
    let totalRevenue = 0;
    let totalOrders = orders.length;
    let totalCustomersCount = customers.length;
    
    let totalUnpaid = 0;
    let currentAmount = 0;
    let overdueAmount = 0;

    const now = new Date();

    orders.forEach(order => {
        totalRevenue += order.totalAmount;
        const due = order.totalAmount - (order.paidAmount || 0);
        if (due > 0) {
            totalUnpaid += due;
            const orderDate = new Date(order.date);
            const daysOld = (now - orderDate) / (1000 * 60 * 60 * 24);
            if (daysOld > 30) {
                overdueAmount += due;
            } else {
                currentAmount += due;
            }
        }
    });

    document.getElementById('dashTotalRevenue').textContent = `₹${totalRevenue.toFixed(2)}`;
    
    document.getElementById('dashTotalUnpaid').textContent = `₹${totalUnpaid.toFixed(2)}`;
    document.getElementById('dashCurrentAmount').textContent = `₹${currentAmount.toFixed(2)}`;
    document.getElementById('dashOverdueAmount').textContent = `₹${overdueAmount.toFixed(2)}`;
    
    const curPercent = totalUnpaid > 0 ? (currentAmount / totalUnpaid) * 100 : 0;
    const overPercent = totalUnpaid > 0 ? (overdueAmount / totalUnpaid) * 100 : 0;
    
    document.getElementById('dashCurrentBar').style.width = `${curPercent}%`;
    document.getElementById('dashOverdueBar').style.width = `${overPercent}%`;

    // Cash Flow calculations (last 7 days)
    let dates = [];
    let cashData = [];
    let openingBal = 0; // Mock opening balance based on total history minus 7 days
    let incoming = 0;
    
    for (let i = 6; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        dates.push(d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }));
    }

    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    
    let cumulativeCash = 0;
    
    paymentHistory.forEach(pay => {
        const payDate = new Date(pay.date);
        if (payDate < weekAgo) {
            openingBal += pay.amount;
        } else {
            incoming += pay.amount;
        }
    });
    
    cumulativeCash = openingBal;
    
    const paymentsByDate = {};
    paymentHistory.forEach(pay => {
        const payDate = new Date(pay.date);
        if (payDate >= weekAgo) {
            const dStr = payDate.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
            paymentsByDate[dStr] = (paymentsByDate[dStr] || 0) + pay.amount;
        }
    });
    
    dates.forEach(d => {
        cumulativeCash += (paymentsByDate[d] || 0);
        cashData.push(cumulativeCash);
    });
    
    const closingBal = cumulativeCash;

    document.getElementById('dashOpeningBal').textContent = `₹${openingBal.toFixed(2)}`;
    document.getElementById('dashIncoming').innerHTML = `₹${incoming.toFixed(2)} <small>+</small>`;
    document.getElementById('dashClosingBal').innerHTML = `₹${closingBal.toFixed(2)} <small>=</small>`;

    // Chart.js
    const ctx = document.getElementById('cashFlowChart');
    if (!ctx) return;
    
    if (typeof window.Chart !== 'undefined') {
        if (cashFlowChartInstance) {
            cashFlowChartInstance.destroy();
        }
        
        cashFlowChartInstance = new window.Chart(ctx, {
            type: 'line',
            data: {
                labels: dates,
                datasets: [{
                    label: 'Cash Flow',
                    data: cashData,
                    borderColor: '#64748b', // Muted slate gray instead of bright green
                    backgroundColor: 'rgba(100, 116, 139, 0.1)', // Very soft slate tint
                    borderWidth: 2,
                    fill: true,
                    tension: 0.4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false }
                },
                scales: {
                    y: { beginAtZero: true, grid: { color: 'rgba(0,0,0,0.05)' } },
                    x: { grid: { display: false } }
                }
            }
        });
    }
}

// --- View Switching ---
function switchView(viewId) {
    document.getElementById('homeView').style.display = 'none';
    document.getElementById('mainView').style.display = 'none';
    document.getElementById('billsView').style.display = 'none';
    document.getElementById('historyView').style.display = 'none';
    document.getElementById('customersView').style.display = 'none';

    document.getElementById(viewId).style.display = viewId === 'mainView' ? 'grid' : 'block';

    if (viewId === 'homeView') renderHomeDashboard();
    if (viewId === 'billsView') renderBills();
    if (viewId === 'historyView') renderPaymentHistory();
    if (viewId === 'customersView') renderCustomersList();

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

    const sortedHistory = [...paymentHistory].sort((a, b) => new Date(b.date) - new Date(a.date));

    sortedHistory.forEach(pay => {
        const d = new Date(pay.date);
        const dateString = d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
        const timeString = d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

        const card = document.createElement('div');
        card.className = 'bill-card';
        card.style.marginBottom = '10px';
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

// --- Bills Management ---
function renderBills() {
    const container = document.getElementById('billsListContainer');
    if (!container) return;
    container.innerHTML = '';

    if (orders.length === 0) {
        container.innerHTML = '<p style="text-align:center; color:var(--text-secondary); margin-top:20px; font-style:italic;">No bills saved yet.</p>';
        return;
    }

    // Show newest first
    const sortedOrders = [...orders].reverse();

    // Group by customer
    const groupedOrders = {};
    sortedOrders.forEach(order => {
        const customerName = order.customerName ||
            (customers.find(c => c.id === order.customerId) || {}).name ||
            'Unknown Customer';

        if (!groupedOrders[customerName]) {
            groupedOrders[customerName] = [];
        }
        groupedOrders[customerName].push(order);
    });

    Object.keys(groupedOrders).sort((a, b) => a.localeCompare(b)).forEach(customerName => {
        const customerOrders = groupedOrders[customerName];

        let totalDue = 0;
        customerOrders.forEach(order => {
            totalDue += (order.totalAmount - (order.paidAmount || 0));
        });

        const folderDiv = document.createElement('div');
        folderDiv.className = 'customer-folder';

        const folderId = 'folder-' + customerName.replace(/[^a-zA-Z0-9]/g, '-');

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
            <span class="folder-icon" id="icon-${folderId}">▼</span>
        `;

        // Folder Content (Bills)
        const folderContent = document.createElement('div');
        folderContent.id = folderId;
        folderContent.className = 'customer-folder-content';
        folderContent.style.display = 'none'; // Hidden by default

        customerOrders.forEach(order => {
            const dateObj = new Date(order.date);
            const dateString = dateObj.toLocaleDateString('en-IN', {
                day: '2-digit', month: 'short', year: 'numeric',
                hour: '2-digit', minute: '2-digit'
            });

            const billCard = document.createElement('div');
            billCard.className = 'bill-card';

            let itemsHtml = '<ul class="bill-items">';
            order.items.forEach(item => {
                itemsHtml += `<li><span>${item.name} × ${item.quantity}</span><span>₹${(item.price * item.quantity).toFixed(2)}</span></li>`;
            });
            if (order.previousDue > 0) {
                itemsHtml += `<li style="border-top: 1px dashed var(--panel-border); padding-top: 6px; margin-top: 4px; color: var(--danger-color); font-weight: 500;"><span>Previous Due</span><span>₹${order.previousDue.toFixed(2)}</span></li>`;
            }
            itemsHtml += '</ul>';

            const paid = order.paidAmount || 0;
            const pending = order.totalAmount - paid;

            let footerHtml = '';
            if (order.adjustedWithOrderId) {
                const adjustedOrder = orders.find(o => o.id === order.adjustedWithOrderId);
                let adjustedDateString = 'a newer bill';
                if (adjustedOrder) {
                    const d = new Date(adjustedOrder.date);
                    adjustedDateString = d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) + ' bill';
                }
                footerHtml = `
                    <div style="display:flex; justify-content:space-between; width:100%; margin-bottom: 8px;">
                        <span>Total</span>
                        <strong>₹${order.totalAmount.toFixed(2)}</strong>
                    </div>
                    <div style="text-align:center; color:var(--accent-color); font-size:0.85rem; font-weight:600; padding: 6px; border: 1px dashed var(--accent-color); border-radius: 6px;">
                        🔄 Adjusted with the ${adjustedDateString}
                    </div>
                `;
            } else {
                footerHtml = `
                    <div style="display:flex; justify-content:space-between; width:100%;">
                        <span>Total</span>
                        <strong>₹${order.totalAmount.toFixed(2)}</strong>
                    </div>
                    <div style="display:flex; justify-content:space-between; width:100%; color:var(--text-secondary); font-size:0.9rem;">
                        <span>Paid</span>
                        <span>₹${paid.toFixed(2)}</span>
                    </div>
                    <div style="display:flex; justify-content:space-between; width:100%; color: ${pending > 0 ? 'var(--danger-color)' : 'var(--success-color)'}; font-weight:600;">
                        <span>Due</span>
                        <span>₹${pending.toFixed(2)}</span>
                    </div>
                    ${pending > 0 ? `<button class="btn btn-secondary full-width" style="margin-top:8px; font-size:0.85rem; padding:6px;" onclick="openPaymentModal('${order.id}')">💰 Record Payment</button>` : `<div style="text-align:center; color:var(--success-color); font-size:0.85rem; margin-top:8px; font-weight:600;">✅ Fully Paid</div>`}
                `;
            }

            billCard.innerHTML = `
                <div class="bill-card-header">
                    <div>
                        <span class="bill-date">${dateString}</span>
                    </div>
                    <div style="display: flex; gap: 8px;">
                        <button class="btn btn-secondary share-bill-btn" onclick="shareBill('${order.id}')" title="Share this bill">📤 Share</button>
                        <button class="btn btn-primary share-bill-btn" onclick="printInvoice('${order.id}')" title="Print Invoice">🖨️ Print</button>
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

    if (content.style.display === 'none') {
        content.style.display = 'block';
        icon.textContent = '▲';
    } else {
        content.style.display = 'none';
        icon.textContent = '▼';
    }
}

function shareBill(orderId) {
    const order = orders.find(o => o.id === orderId);
    if (!order) {
        showToast('Bill not found.');
        return;
    }

    const customerName = order.customerName ||
        (customers.find(c => c.id === order.customerId) || {}).name ||
        'Customer';

    const billText = buildBillText(customerName, order.items, order.totalAmount, order.previousDue || 0);
    shareAsImage(billText, `Bill for ${customerName}`);
}

function printInvoice(orderId) {
    const order = orders.find(o => o.id === orderId);
    if (!order) return;

    const customerName = order.customerName ||
        (customers.find(c => c.id === order.customerId) || {}).name || 'Customer';

    const dateObj = new Date(order.date);
    const dateString = dateObj.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' });

    const paid = order.paidAmount || 0;
    const balanceDue = order.totalAmount - paid;

    let itemsHtml = '';
    order.items.forEach((item, index) => {
        itemsHtml += `
            <tr>
                <td style="padding: 12px 15px; border-bottom: 1px solid #eee;">${index + 1}</td>
                <td style="padding: 12px 15px; border-bottom: 1px solid #eee;"><strong>${item.name}</strong></td>
                <td style="padding: 12px 15px; border-bottom: 1px solid #eee; text-align: center;">${item.quantity.toFixed(2)}</td>
                <td style="padding: 12px 15px; border-bottom: 1px solid #eee; text-align: right;">${item.price.toFixed(2)}</td>
                <td style="padding: 12px 15px; border-bottom: 1px solid #eee; text-align: right;">0.00</td>
                <td style="padding: 12px 15px; border-bottom: 1px solid #eee; text-align: right;">${(item.price * item.quantity).toFixed(2)}</td>
            </tr>
        `;
    });

    const printWindow = window.open('', '', 'width=800,height=900');
    printWindow.document.write(`
    <html>
    <head>
        <title>Invoice - ${customerName}</title>
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
            .totals { width: 40%; margin-left: auto; margin-right: 0; font-size: 14px; }
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
                Customer ID: ${order.customerId}<br>
            </div>
            <div>
                <table class="meta-table">
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
                    <th class="right">Discount</th>
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
                <span>${(order.totalAmount - (order.previousDue || 0)).toFixed(2)}</span>
            </div>
            ${order.previousDue ? `
            <div class="totals-row">
                <span>Previous Due</span>
                <span>${order.previousDue.toFixed(2)}</span>
            </div>` : ''}
            <div class="totals-row bold" style="margin-top: 10px;">
                <span>Total</span>
                <span>₹ ${order.totalAmount.toFixed(2)}</span>
            </div>
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

// --- Logout ---
function logout() {
    sessionStorage.removeItem('taruchhaya_loggedIn');
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



