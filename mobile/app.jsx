// SpendWise - Production Mobile App
// React + Capacitor hybrid (iOS + Android)
// Full offline-first with sync, themes, accessibility

import React, { createContext, useCallback, useContext, useEffect, useReducer, useRef, useState } from 'react';

// ─── Theme System ──────────────────────────────────────────────────────────────

const THEMES = {
  light: {
    bg: '#F8F9FA', surface: '#FFFFFF', surfaceAlt: '#F1F3F5',
    border: '#E9ECEF', text: '#1A1A2E', textSub: '#6C757D',
    primary: '#4F46E5', primaryLight: '#EEF2FF',
    success: '#10B981', warning: '#F59E0B', danger: '#EF4444',
    card: '#FFFFFF', shadow: 'rgba(0,0,0,0.08)',
  },
  dark: {
    bg: '#0F0F1A', surface: '#1A1A2E', surfaceAlt: '#16213E',
    border: '#2D2D44', text: '#F0F0FF', textSub: '#9090B0',
    primary: '#6366F1', primaryLight: '#1E1B4B',
    success: '#10B981', warning: '#F59E0B', danger: '#EF4444',
    card: '#1A1A2E', shadow: 'rgba(0,0,0,0.4)',
  },
};

const COLOR_SCHEMES = {
  indigo:  { primary: '#4F46E5', primaryLight: '#EEF2FF' },
  emerald: { primary: '#059669', primaryLight: '#ECFDF5' },
  rose:    { primary: '#E11D48', primaryLight: '#FFF1F2' },
  amber:   { primary: '#D97706', primaryLight: '#FFFBEB' },
  violet:  { primary: '#7C3AED', primaryLight: '#F5F3FF' },
  sky:     { primary: '#0284C7', primaryLight: '#F0F9FF' },
};

// ─── Currency helpers ─────────────────────────────────────────────────────────

const CURRENCY_SYMBOLS = {
  USD: '$', EUR: '€', GBP: '£', JPY: '¥', CAD: 'C$',
  AUD: 'A$', INR: '₹', SGD: 'S$', CHF: 'Fr', CNY: '¥',
};

function formatCurrency(amount, currency = 'USD') {
  const symbol = CURRENCY_SYMBOLS[currency] || currency + ' ';
  return `${symbol}${parseFloat(amount || 0).toFixed(2)}`;
}

// ─── Offline DB (IndexedDB) ────────────────────────────────────────────────────

class OfflineDB {
  static db = null;
  static async open() {
    if (this.db) return this.db;
    return new Promise((res, rej) => {
      const req = indexedDB.open('SpendWise', 3);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        const stores = {
          expenses:       { keyPath: 'id', indexes: [['user_id','user_id'],['expense_date','expense_date'],['updated_at','updated_at']] },
          categories:     { keyPath: 'id', indexes: [['user_id','user_id']] },
          tags:           { keyPath: 'id', indexes: [['user_id','user_id']] },
          budgets:        { keyPath: 'id', indexes: [['user_id','user_id']] },
          sync_queue:     { keyPath: 'id', indexes: [['created_at','created_at']] },
          settings:       { keyPath: 'key' },
          notifications:  { keyPath: 'id', indexes: [['created_at','created_at']] },
        };
        for (const [name, { keyPath, indexes }] of Object.entries(stores)) {
          if (!db.objectStoreNames.contains(name)) {
            const store = db.createObjectStore(name, { keyPath });
            (indexes || []).forEach(([iName, iKey]) => store.createIndex(iName, iKey));
          }
        }
      };
      req.onsuccess = () => { this.db = req.result; res(req.result); };
      req.onerror = () => rej(req.error);
    });
  }
  static async get(store, key) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).get(key);
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  }
  static async put(store, value) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction(store, 'readwrite');
      const req = tx.objectStore(store).put(value);
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  }
  static async getAll(store) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).getAll();
      req.onsuccess = () => res(req.result || []);
      req.onerror = () => rej(req.error);
    });
  }
  static async delete(store, key) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction(store, 'readwrite');
      const req = tx.objectStore(store).delete(key);
      req.onsuccess = () => res();
      req.onerror = () => rej(req.error);
    });
  }
}

// ─── Sync Engine ──────────────────────────────────────────────────────────────

class SyncEngine {
  static BASE_URL = (typeof window !== 'undefined' && window.SPENDWISE_API) || (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_API_URL) || 'http://localhost:8000/api/v1';
  static syncInProgress = false;
  static getToken() { return localStorage.getItem('sw_access_token'); }
  static async fetch(path, opts = {}) {
    const token = this.getToken();
    const res = await fetch(`${this.BASE_URL}${path}`, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(opts.headers || {}) },
    });
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error || `HTTP ${res.status}`); }
    return res.json();
  }
  static async queueMutation(entity_type, entity_id, operation, payload) {
    await OfflineDB.put('sync_queue', { id: `${Date.now()}-${Math.random()}`, entity_type, entity_id, operation, payload, created_at: new Date().toISOString() });
  }
}

// ─── ML Categorizer ───────────────────────────────────────────────────────────

const CATEGORY_RULES = {
  'Food & Dining':    ['restaurant','cafe','coffee','pizza','burger','sushi','mcdonald','starbucks','subway','bakery','grill','dining','food'],
  'Groceries':        ['grocery','supermarket','walmart','target','costco','kroger','safeway','whole foods','trader','aldi','market','fresh'],
  'Transportation':   ['uber','lyft','taxi','bus','metro','train','flight','airport','fuel','gas','shell','bp','exxon','parking','toll'],
  'Shopping':         ['amazon','ebay','etsy','mall','store','shop','retail','clothing','fashion','shoes','electronics','best buy','apple'],
  'Healthcare':       ['pharmacy','cvs','walgreens','hospital','clinic','doctor','medical','dental','health','prescription'],
  'Entertainment':    ['netflix','spotify','hulu','disney','cinema','movie','theater','concert','game','steam','arcade'],
  'Utilities':        ['electric','water','internet','broadband','phone','telecom','att','verizon','comcast'],
  'Fitness':          ['gym','fitness','yoga','pilates','crossfit','sport','swimming','peloton'],
  'Travel':           ['hotel','resort','hostel','booking','expedia','airbnb','tour','cruise'],
  'Subscriptions':    ['subscription','membership','monthly','annual','premium','saas'],
};
function edgeCategorize(text) {
  const lower = (text || '').toLowerCase();
  for (const [cat, kws] of Object.entries(CATEGORY_RULES)) {
    const match = kws.find(kw => lower.includes(kw));
    if (match) return { category: cat, confidence: Math.min(0.95, 0.6 + match.length / 20) };
  }
  return null;
}

// ─── App State ────────────────────────────────────────────────────────────────

const initialState = {
  user: null, token: null, expenses: [], categories: [], tags: [],
  budgets: [], notifications: [], isOnline: navigator.onLine,
  syncStatus: 'idle', theme: 'light', colorScheme: 'indigo', fontSize: 'md',
  activeTab: 'dashboard', modalOpen: null, editingExpense: null,
  isLoading: false, error: null,
  // Settings toggles
  cloudSyncEnabled: true, offlineBackupEnabled: true,
};

function reducer(state, action) {
  switch (action.type) {
    case 'SET_USER':        return { ...state, user: action.payload, token: action.token };
    case 'UPDATE_USER':     return { ...state, user: { ...state.user, ...action.payload } };
    case 'LOGOUT':          return { ...initialState, theme: state.theme, colorScheme: state.colorScheme };
    case 'SET_EXPENSES':    return { ...state, expenses: action.payload };
    case 'ADD_EXPENSE':     return { ...state, expenses: [action.payload, ...state.expenses] };
    case 'UPDATE_EXPENSE':  return { ...state, expenses: state.expenses.map(e => e.id === action.payload.id ? action.payload : e) };
    case 'DELETE_EXPENSE':  return { ...state, expenses: state.expenses.filter(e => e.id !== action.id) };
    case 'SET_CATEGORIES':  return { ...state, categories: action.payload };
    case 'SET_BUDGETS':     return { ...state, budgets: action.payload };
    case 'ADD_BUDGET':      return { ...state, budgets: [action.payload, ...state.budgets] };
    case 'UPDATE_BUDGET':   return { ...state, budgets: state.budgets.map(b => b.id === action.payload.id ? action.payload : b) };
    case 'DELETE_BUDGET':   return { ...state, budgets: state.budgets.filter(b => b.id !== action.id) };
    case 'SET_NOTIFICATIONS': return { ...state, notifications: action.payload };
    case 'DISMISS_NOTIFICATION': return { ...state, notifications: state.notifications.filter(n => n.id !== action.id) };
    case 'SET_ONLINE':      return { ...state, isOnline: action.payload };
    case 'SET_THEME':       return { ...state, theme: action.payload };
    case 'SET_COLOR':       return { ...state, colorScheme: action.payload };
    case 'SET_FONTSIZE':    return { ...state, fontSize: action.payload };
    case 'SET_TAB':         return { ...state, activeTab: action.payload };
    case 'OPEN_MODAL':      return { ...state, modalOpen: action.payload, editingExpense: action.expense || null };
    case 'CLOSE_MODAL':     return { ...state, modalOpen: null, editingExpense: null };
    case 'TOGGLE_CLOUD_SYNC':   return { ...state, cloudSyncEnabled: !state.cloudSyncEnabled };
    case 'TOGGLE_OFFLINE_BACKUP': return { ...state, offlineBackupEnabled: !state.offlineBackupEnabled };
    default:                return state;
  }
}

const AppCtx = createContext(null);
const useApp = () => useContext(AppCtx);

// ─── Category constants ────────────────────────────────────────────────────────

const CAT_COLORS = {
  'Food & Dining': '#F59E0B', 'Groceries': '#10B981', 'Transportation': '#3B82F6',
  'Shopping': '#8B5CF6', 'Healthcare': '#EF4444', 'Entertainment': '#EC4899',
  'Utilities': '#6366F1', 'Housing': '#78716C', 'Education': '#06B6D4',
  'Financial': '#14B8A6', 'Fitness': '#84CC16', 'Travel': '#F97316',
  'Subscriptions': '#A78BFA', 'Other': '#9CA3AF',
};
const CAT_ICONS = {
  'Food & Dining':'🍽️','Groceries':'🛒','Transportation':'🚗','Shopping':'🛍️',
  'Healthcare':'🏥','Entertainment':'🎬','Utilities':'⚡','Housing':'🏠',
  'Education':'📚','Financial':'💳','Fitness':'💪','Travel':'✈️',
  'Subscriptions':'📱','Other':'📌',
};

// ─── Icon Component ────────────────────────────────────────────────────────────

const Icon = ({ name, size = 20, color = 'currentColor', style = {} }) => {
  const icons = {
    home: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6',
    plus: 'M12 4v16m8-8H4', minus: 'M20 12H4',
    chart: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z',
    wallet: 'M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z',
    settings: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z',
    bell: 'M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9',
    receipt: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2',
    calendar: 'M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z',
    check: 'M5 13l4 4L19 7',
    x: 'M6 18L18 6M6 6l12 12',
    edit: 'M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z',
    trash: 'M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16',
    search: 'M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z',
    filter: 'M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z',
    export: 'M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4',
    sync: 'M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15',
    chevron_down: 'M19 9l-7 7-7-7',
    chevron_up: 'M5 15l7-7 7 7',
    user: 'M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z',
    lock: 'M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z',
    warning: 'M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z',
    info: 'M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
    map_pin: 'M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z M15 11a3 3 0 11-6 0 3 3 0 016 0z',
    tag: 'M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z',
    credit_card: 'M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z',
    people: 'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z',
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color}
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={style} aria-hidden="true">
      {(icons[name] || '').split(' M').map((d, i) => (
        <path key={i} d={i === 0 ? d : 'M' + d} />
      ))}
    </svg>
  );
};

// ─── Main App ──────────────────────────────────────────────────────────────────

export default function SpendWiseApp() {
  const [state, dispatch] = useReducer(reducer, {
    ...initialState,
    theme: localStorage.getItem('sw_theme') || 'light',
    colorScheme: localStorage.getItem('sw_color') || 'indigo',
    fontSize: localStorage.getItem('sw_fontsize') || 'md',
  });

  // Persist preferences
  useEffect(() => { localStorage.setItem('sw_theme', state.theme); }, [state.theme]);
  useEffect(() => { localStorage.setItem('sw_color', state.colorScheme); }, [state.colorScheme]);
  useEffect(() => { localStorage.setItem('sw_fontsize', state.fontSize); }, [state.fontSize]);

  // Network status
  useEffect(() => {
    const on = () => dispatch({ type: 'SET_ONLINE', payload: true });
    const off = () => dispatch({ type: 'SET_ONLINE', payload: false });
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);

  // Load initial notifications
  useEffect(() => {
    dispatch({ type: 'SET_NOTIFICATIONS', payload: [
      { id: 'n1', icon: '⚠️', title: 'Budget Alert', body: "You've used 80% of your Food budget", time: '2m ago', type: 'warning' },
      { id: 'n2', icon: '🔁', title: 'Recurring Due', body: 'Netflix subscription is due today', time: '1h ago', type: 'info' },
      { id: 'n3', icon: '📊', title: 'Weekly Summary', body: 'You spent $334.52 this week', time: '2d ago', type: 'success' },
    ]});
  }, []);

  // Demo data
  useEffect(() => {
    const sampleExpenses = [
      { id: '1', merchant_name: 'Starbucks', amount: 5.40, currency: 'USD', base_amount: 5.40, category: 'Food & Dining', expense_date: new Date(Date.now() - 86400000).toISOString(), payment_method: 'credit_card', notes: 'Morning coffee', location_name: 'Downtown', tags: ['work'] },
      { id: '2', merchant_name: 'Uber', amount: 18.90, currency: 'USD', base_amount: 18.90, category: 'Transportation', expense_date: new Date(Date.now() - 172800000).toISOString(), payment_method: 'digital_wallet', notes: 'Airport ride', location_name: 'Airport', tags: ['travel'] },
      { id: '3', merchant_name: 'Whole Foods', amount: 127.45, currency: 'USD', base_amount: 127.45, category: 'Groceries', expense_date: new Date(Date.now() - 259200000).toISOString(), payment_method: 'debit_card', notes: 'Weekly shopping', location_name: 'Times Square', tags: [] },
      { id: '4', merchant_name: 'Netflix', amount: 15.99, currency: 'USD', base_amount: 15.99, category: 'Subscriptions', expense_date: new Date(Date.now() - 345600000).toISOString(), payment_method: 'credit_card', notes: 'Monthly subscription', tags: ['recurring'] },
      { id: '5', merchant_name: 'Planet Fitness', amount: 24.99, currency: 'USD', base_amount: 24.99, category: 'Fitness', expense_date: new Date(Date.now() - 432000000).toISOString(), payment_method: 'credit_card', notes: 'Gym membership', tags: ['health', 'recurring'] },
      { id: '6', merchant_name: 'Amazon', amount: 89.99, currency: 'USD', base_amount: 89.99, category: 'Shopping', expense_date: new Date(Date.now() - 518400000).toISOString(), payment_method: 'credit_card', notes: 'Headphones', tags: ['online'] },
      { id: '7', merchant_name: 'CVS Pharmacy', amount: 34.20, currency: 'USD', base_amount: 34.20, category: 'Healthcare', expense_date: new Date(Date.now() - 604800000).toISOString(), payment_method: 'debit_card', notes: 'Prescriptions', tags: ['health'] },
      { id: '8', merchant_name: 'Chipotle', amount: 12.75, currency: 'USD', base_amount: 12.75, category: 'Food & Dining', expense_date: new Date(Date.now() - 691200000).toISOString(), payment_method: 'cash', notes: 'Lunch with colleague', tags: [] },
    ];
    const sampleBudgets = [
      { id: 'b1', name: 'Monthly Food', amount: 500, currency: 'USD', spent: 143.60, category: 'Food & Dining', period_start: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString() },
      { id: 'b2', name: 'Shopping Budget', amount: 200, currency: 'USD', spent: 89.99, category: 'Shopping', period_start: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString() },
      { id: 'b3', name: 'Transport', amount: 150, currency: 'USD', spent: 18.90, category: 'Transportation', period_start: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString() },
    ];
    dispatch({ type: 'SET_EXPENSES', payload: sampleExpenses });
    dispatch({ type: 'SET_BUDGETS', payload: sampleBudgets });
    // Demo user — isDemo flag controls "Synced" display
    dispatch({ type: 'SET_USER', payload: { id: 'demo', display_name: 'Alex Morgan', email: 'alex@example.com', base_currency: 'USD', isDemo: true }, token: 'demo' });
  }, []);

  const theme = { ...THEMES[state.theme], ...COLOR_SCHEMES[state.colorScheme] };
  const fontSize = { sm: 0.875, md: 1, lg: 1.125, xl: 1.25 }[state.fontSize] || 1;
  const ctx = { state, dispatch, theme, fontSize };

  return (
    <AppCtx.Provider value={ctx}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
        ::-webkit-scrollbar { width: 4px; } ::-webkit-scrollbar-thumb { background: ${theme.border}; border-radius: 2px; }
        input, textarea, select { font-family: inherit; color: ${theme.text}; background: ${theme.surfaceAlt}; }
        button { cursor: pointer; font-family: inherit; }
        @keyframes slideUp { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes slideLeft { from { transform: translateX(0); opacity: 1; } to { transform: translateX(-120%); opacity: 0; } }
        .slide-up { animation: slideUp 0.3s ease; }
        .fade-in { animation: fadeIn 0.2s ease; }
      `}</style>
      <div style={{
        fontFamily: "'DM Sans', -apple-system, sans-serif",
        background: theme.bg, color: theme.text,
        minHeight: '100vh', maxWidth: 430, margin: '0 auto',
        position: 'relative', fontSize: `${fontSize}rem`, overflowX: 'hidden',
      }} role="main">
        <Header />
        <main style={{ paddingBottom: 80, minHeight: 'calc(100vh - 60px)', overflowY: 'auto' }}>
          {state.activeTab === 'dashboard' && <Dashboard />}
          {state.activeTab === 'expenses'  && <ExpenseList />}
          {state.activeTab === 'budgets'   && <BudgetsScreen />}
          {state.activeTab === 'analytics' && <AnalyticsScreen />}
          {state.activeTab === 'settings'  && <SettingsScreen />}
        </main>
        <BottomNav />
        {state.modalOpen === 'add_expense'   && <ExpenseModal />}
        {state.modalOpen === 'notifications' && <NotificationsPanel />}
        {state.modalOpen === 'add_budget'    && <BudgetModal />}
        {state.modalOpen === 'signin'        && <SignInModal />}
        <FAB />
      </div>
    </AppCtx.Provider>
  );
}

// ─── Header ───────────────────────────────────────────────────────────────────

function Header() {
  const { state, dispatch, theme } = useApp();
  const titles = { dashboard: '💸 SpendWise', expenses: 'Expenses', budgets: 'Budgets', analytics: 'Analytics', settings: 'Settings' };
  // FIX: Only show "Synced" green if user is actually signed in (not demo)
  const isRealUser = state.user && !state.user.isDemo;
  const syncColor = isRealUser && state.isOnline ? theme.success : theme.warning;
  const syncLabel = isRealUser && state.isOnline ? 'Synced' : state.user?.isDemo ? 'Demo' : 'Offline';

  return (
    <header style={{
      background: theme.surface, padding: '14px 16px', display: 'flex',
      alignItems: 'center', justifyContent: 'space-between',
      borderBottom: `1px solid ${theme.border}`, position: 'sticky', top: 0, zIndex: 100,
    }}>
      <span style={{ fontSize: 22, fontWeight: 700, color: theme.primary, letterSpacing: -0.5 }}>
        {titles[state.activeTab]}
      </span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.7rem', color: syncColor }}>
          <div style={{ width: 6, height: 6, borderRadius: '50%', background: syncColor }} />
          {syncLabel}
        </div>
        <button onClick={() => dispatch({ type: 'OPEN_MODAL', payload: 'notifications' })}
          style={{ background: 'none', border: 'none', color: theme.textSub, padding: 4, borderRadius: 8, position: 'relative' }}>
          <Icon name="bell" size={20} color={theme.textSub} />
          {state.notifications.length > 0 && (
            <span style={{ position: 'absolute', top: 0, right: 0, width: 8, height: 8, background: theme.danger, borderRadius: '50%', border: `2px solid ${theme.surface}` }} />
          )}
        </button>
      </div>
    </header>
  );
}

// ─── Bottom Nav ───────────────────────────────────────────────────────────────

function BottomNav() {
  const { state, dispatch, theme } = useApp();
  const tabs = [
    { id: 'dashboard', icon: 'home',    label: 'Home'     },
    { id: 'expenses',  icon: 'receipt', label: 'Expenses' },
    { id: 'budgets',   icon: 'wallet',  label: 'Budgets'  },
    { id: 'analytics', icon: 'chart',   label: 'Insights' },
    { id: 'settings',  icon: 'settings',label: 'Settings' },
  ];
  return (
    <nav style={{
      position: 'fixed', bottom: 0, left: '50%', transform: 'translateX(-50%)',
      width: '100%', maxWidth: 430, background: theme.surface,
      borderTop: `1px solid ${theme.border}`, display: 'flex',
      padding: '8px 0 max(8px, env(safe-area-inset-bottom))', zIndex: 100,
    }}>
      {tabs.map(tab => {
        const active = state.activeTab === tab.id;
        return (
          <button key={tab.id} onClick={() => dispatch({ type: 'SET_TAB', payload: tab.id })}
            style={{
              flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
              background: 'none', border: 'none', padding: '6px 4px',
              color: active ? theme.primary : theme.textSub,
              fontSize: '0.65rem', fontWeight: active ? 600 : 400,
            }}>
            <div style={{ padding: 6, borderRadius: 12, background: active ? theme.primaryLight : 'transparent' }}>
              <Icon name={tab.icon} size={18} color={active ? theme.primary : theme.textSub} />
            </div>
            {tab.label}
          </button>
        );
      })}
    </nav>
  );
}

// ─── FAB ──────────────────────────────────────────────────────────────────────

function FAB() {
  const { dispatch, theme } = useApp();
  return (
    <button onClick={() => dispatch({ type: 'OPEN_MODAL', payload: 'add_expense' })}
      style={{
        position: 'fixed', bottom: 76, right: 'calc(50% - 215px + 16px)',
        width: 52, height: 52, borderRadius: '50%', background: theme.primary,
        border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center',
        boxShadow: `0 4px 20px ${theme.primary}60`, zIndex: 99,
      }} aria-label="Add expense">
      <Icon name="plus" size={24} color="white" />
    </button>
  );
}

// ─── Shared components ────────────────────────────────────────────────────────

function Card({ theme, children, style = {} }) {
  return (
    <div style={{
      background: theme.surface, borderRadius: 16, padding: 16,
      border: `1px solid ${theme.border}`, boxShadow: `0 2px 8px ${theme.shadow}`, ...style,
    }}>{children}</div>
  );
}

function EmptyState({ message, sub, theme }) {
  return (
    <div style={{ textAlign: 'center', padding: '48px 24px', color: theme.textSub }}>
      <div style={{ fontSize: 48, marginBottom: 12 }}>💸</div>
      <div style={{ fontWeight: 600, color: theme.text, marginBottom: 6 }}>{message}</div>
      <div style={{ fontSize: '0.85rem' }}>{sub}</div>
    </div>
  );
}

function Toggle({ on, onToggle, theme }) {
  return (
    <div onClick={onToggle}
      style={{ width: 44, height: 24, background: on ? theme.success : theme.border, borderRadius: 12, position: 'relative', cursor: 'pointer', transition: 'background 0.2s' }}>
      <div style={{ width: 18, height: 18, background: 'white', borderRadius: '50%', position: 'absolute', top: 3, left: on ? 23 : 3, transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.3)' }} />
    </div>
  );
}

function FormField({ label, placeholder, value, onChange, theme, type = 'text' }) {
  return (
    <div>
      <label style={{ fontSize: '0.78rem', fontWeight: 600, color: theme.textSub, marginBottom: 6, display: 'block' }}>{label}</label>
      <input type={type} placeholder={placeholder} value={value} onChange={e => onChange(e.target.value)}
        style={{ width: '100%', border: `1px solid ${theme.border}`, borderRadius: 12, padding: '12px 14px', background: theme.surfaceAlt, fontSize: '0.9rem', outline: 'none' }} />
    </div>
  );
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

function getTimeOfDay() {
  const h = new Date().getHours();
  if (h < 12) return 'morning'; if (h < 17) return 'afternoon'; return 'evening';
}

function Dashboard() {
  const { state, theme, dispatch } = useApp();
  const currency = state.user?.base_currency || 'USD';
  const thisMonth = state.expenses.filter(e => {
    const d = new Date(e.expense_date); const now = new Date();
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  });
  const monthTotal = thisMonth.reduce((s, e) => s + (e.base_amount || 0), 0);
  const total = state.expenses.reduce((s, e) => s + (e.base_amount || 0), 0);
  const byCategory = state.expenses.reduce((acc, e) => {
    const cat = e.category || 'Other'; acc[cat] = (acc[cat] || 0) + (e.base_amount || 0); return acc;
  }, {});
  const topCategories = Object.entries(byCategory).sort((a, b) => b[1] - a[1]).slice(0, 5);

  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }} className="fade-in">
      <div>
        <p style={{ color: theme.textSub, fontSize: '0.85rem' }}>Good {getTimeOfDay()},</p>
        <h2 style={{ fontSize: '1.4rem', fontWeight: 700 }}>{state.user?.display_name?.split(' ')[0] || 'there'} 👋</h2>
      </div>

      {/* Summary — FIX: use user's currency */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {[
          { label: 'This Month', value: formatCurrency(monthTotal, currency), icon: '📅', color: theme.primary },
          { label: 'All Time',   value: formatCurrency(total, currency),      icon: '💰', color: theme.success },
          { label: 'Transactions', value: state.expenses.length,              icon: '📊', color: theme.warning },
          { label: 'Budgets',    value: state.budgets.length,                 icon: '🎯', color: '#EC4899' },
        ].map(({ label, value, icon, color }) => (
          <div key={label} style={{ background: theme.surface, borderRadius: 16, padding: 16, border: `1px solid ${theme.border}`, boxShadow: `0 2px 8px ${theme.shadow}` }}>
            <div style={{ fontSize: 24, marginBottom: 8 }}>{icon}</div>
            <div style={{ fontSize: '1.2rem', fontWeight: 700, color }}>{value}</div>
            <div style={{ fontSize: '0.72rem', color: theme.textSub, marginTop: 2 }}>{label}</div>
          </div>
        ))}
      </div>

      {/* Budget Overview */}
      {state.budgets.length > 0 && (
        <Card theme={theme}>
          <h3 style={{ fontSize: '0.95rem', fontWeight: 600, marginBottom: 12 }}>Budget Overview</h3>
          {state.budgets.map(budget => {
            const pct = Math.min(100, ((budget.spent || 0) / budget.amount) * 100);
            const color = pct > 90 ? theme.danger : pct > 70 ? theme.warning : theme.success;
            return (
              <div key={budget.id} style={{ marginBottom: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span style={{ fontSize: '0.8rem', fontWeight: 500 }}>{budget.name}</span>
                  <span style={{ fontSize: '0.8rem', color: theme.textSub }}>{formatCurrency(budget.spent || 0, budget.currency)} / {formatCurrency(budget.amount, budget.currency)}</span>
                </div>
                <div style={{ height: 6, background: theme.border, borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 3, transition: 'width 0.5s ease' }} />
                </div>
              </div>
            );
          })}
        </Card>
      )}

      {/* Top Categories */}
      {topCategories.length > 0 && (
        <Card theme={theme}>
          <h3 style={{ fontSize: '0.95rem', fontWeight: 600, marginBottom: 12 }}>Top Categories</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {topCategories.map(([cat, amount]) => {
              const pct = total > 0 ? (amount / total * 100) : 0;
              const color = CAT_COLORS[cat] || '#9CA3AF';
              return (
                <div key={cat} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: 20, width: 28, textAlign: 'center' }}>{CAT_ICONS[cat] || '📌'}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                      <span style={{ fontSize: '0.8rem', fontWeight: 500 }}>{cat}</span>
                      <span style={{ fontSize: '0.8rem', color: theme.textSub }}>{formatCurrency(amount, currency)}</span>
                    </div>
                    <div style={{ height: 4, background: theme.border, borderRadius: 2 }}>
                      <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 2 }} />
                    </div>
                  </div>
                  <span style={{ fontSize: '0.7rem', color: theme.textSub, width: 32, textAlign: 'right' }}>{pct.toFixed(0)}%</span>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* Recent */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ fontSize: '0.95rem', fontWeight: 600 }}>Recent Expenses</h3>
          <button onClick={() => dispatch({ type: 'SET_TAB', payload: 'expenses' })}
            style={{ background: 'none', border: 'none', color: theme.primary, fontSize: '0.8rem', fontWeight: 500 }}>View all →</button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {state.expenses.slice(0, 4).map(e => <ExpenseRow key={e.id} expense={e} theme={theme} />)}
        </div>
      </div>
    </div>
  );
}

// ─── Expense Row — FIX: expandable with full details ─────────────────────────

function ExpenseRow({ expense, theme, onEdit, onDelete }) {
  const [expanded, setExpanded] = useState(false);
  const cat = expense.category || 'Other';
  const color = CAT_COLORS[cat] || '#9CA3AF';
  const icon = CAT_ICONS[cat] || '📌';
  const methodLabels = { credit_card: '💳 Credit Card', debit_card: '🏦 Debit Card', cash: '💵 Cash', digital_wallet: '📱 Digital Wallet', bank_transfer: '🏛️ Bank Transfer' };

  return (
    <div style={{ background: theme.surface, borderRadius: 14, border: `1px solid ${theme.border}`, overflow: 'hidden' }}>
      {/* Main row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', cursor: 'pointer' }}
        onClick={() => setExpanded(!expanded)}>
        <div style={{ width: 40, height: 40, borderRadius: 12, background: `${color}20`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, flexShrink: 0 }}>{icon}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 500, fontSize: '0.9rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{expense.merchant_name || 'Expense'}</div>
          <div style={{ fontSize: '0.75rem', color: theme.textSub }}>{cat} · {new Date(expense.expense_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</div>
        </div>
        <div style={{ fontWeight: 600, color: theme.danger, flexShrink: 0 }}>{formatCurrency(expense.amount, expense.currency || 'USD')}</div>
        <Icon name={expanded ? 'chevron_up' : 'chevron_down'} size={14} color={theme.textSub} />
      </div>

      {/* FIX: Expanded detail panel */}
      {expanded && (
        <div style={{ padding: '0 14px 14px', borderTop: `1px solid ${theme.border}`, background: theme.surfaceAlt }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, paddingTop: 12 }}>
            <DetailItem icon="💳" label="Payment" value={methodLabels[expense.payment_method] || expense.payment_method || 'N/A'} theme={theme} />
            <DetailItem icon="📅" label="Date" value={new Date(expense.expense_date).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} theme={theme} />
            {expense.location_name && <DetailItem icon="📍" label="Location" value={expense.location_name} theme={theme} />}
            <DetailItem icon="💱" label="Currency" value={expense.currency || 'USD'} theme={theme} />
          </div>
          {expense.notes && (
            <div style={{ marginTop: 8, padding: '8px 10px', background: theme.surface, borderRadius: 8 }}>
              <span style={{ fontSize: '0.72rem', color: theme.textSub, fontWeight: 600 }}>NOTES  </span>
              <span style={{ fontSize: '0.82rem' }}>{expense.notes}</span>
            </div>
          )}
          {expense.tags?.length > 0 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
              {expense.tags.map(tag => (
                <span key={tag} style={{ fontSize: '0.7rem', padding: '3px 8px', borderRadius: 20, background: theme.primaryLight, color: theme.primary, fontWeight: 500 }}>#{tag}</span>
              ))}
            </div>
          )}
          {(onEdit || onDelete) && (
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              {onEdit && (
                <button onClick={(e) => { e.stopPropagation(); onEdit(expense); }}
                  style={{ flex: 1, padding: '8px', borderRadius: 10, border: `1px solid ${theme.border}`, background: theme.surface, color: theme.primary, fontWeight: 600, fontSize: '0.82rem' }}>
                  ✏️ Edit
                </button>
              )}
              {onDelete && (
                <button onClick={(e) => { e.stopPropagation(); onDelete(expense.id); }}
                  style={{ flex: 1, padding: '8px', borderRadius: 10, border: `1px solid ${theme.danger}20`, background: `${theme.danger}10`, color: theme.danger, fontWeight: 600, fontSize: '0.82rem' }}>
                  🗑️ Delete
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DetailItem({ icon, label, value, theme }) {
  return (
    <div style={{ padding: '6px 8px', background: theme.surface, borderRadius: 8 }}>
      <div style={{ fontSize: '0.68rem', color: theme.textSub, fontWeight: 600, marginBottom: 2 }}>{icon} {label}</div>
      <div style={{ fontSize: '0.78rem', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</div>
    </div>
  );
}

// ─── Expense List ─────────────────────────────────────────────────────────────

function ExpenseList() {
  const { state, dispatch, theme } = useApp();
  const [search, setSearch] = useState('');
  const [filterCat, setFilterCat] = useState('');
  const [showFilters, setShowFilters] = useState(false);

  const filtered = state.expenses.filter(e => {
    const q = search.toLowerCase();
    return (!q || (e.merchant_name || '').toLowerCase().includes(q) || (e.notes || '').toLowerCase().includes(q))
      && (!filterCat || e.category === filterCat) && !e.is_deleted;
  });

  const grouped = filtered.reduce((acc, e) => {
    const key = new Date(e.expense_date).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    if (!acc[key]) acc[key] = [];
    acc[key].push(e);
    return acc;
  }, {});

  const handleDelete = (id) => { if (window.confirm('Delete this expense?')) dispatch({ type: 'DELETE_EXPENSE', id }); };

  return (
    <div style={{ padding: 16 }} className="fade-in">
      <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 12, padding: '10px 14px' }}>
          <Icon name="search" size={16} color={theme.textSub} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search expenses..."
            style={{ border: 'none', outline: 'none', flex: 1, background: 'transparent', fontSize: '0.9rem' }} />
        </div>
        <button onClick={() => setShowFilters(!showFilters)}
          style={{ background: showFilters ? theme.primaryLight : theme.surface, border: `1px solid ${showFilters ? theme.primary : theme.border}`, borderRadius: 12, padding: '10px 14px', color: showFilters ? theme.primary : theme.textSub }}>
          <Icon name="filter" size={18} color={showFilters ? theme.primary : theme.textSub} />
        </button>
      </div>

      {showFilters && (
        <div style={{ display: 'flex', gap: 8, overflowX: 'auto', marginBottom: 12, paddingBottom: 4 }}>
          {['All', ...Object.keys(CAT_COLORS)].map(c => (
            <button key={c} onClick={() => setFilterCat(c === 'All' ? '' : c)}
              style={{ whiteSpace: 'nowrap', padding: '6px 12px', borderRadius: 20, fontSize: '0.78rem', background: (c === 'All' ? !filterCat : filterCat === c) ? theme.primary : theme.surface, color: (c === 'All' ? !filterCat : filterCat === c) ? 'white' : theme.textSub, border: `1px solid ${(c === 'All' ? !filterCat : filterCat === c) ? theme.primary : theme.border}`, fontWeight: 500 }}>
              {c === 'All' ? 'All' : `${CAT_ICONS[c]} ${c}`}
            </button>
          ))}
        </div>
      )}

      {Object.entries(grouped).length === 0 ? (
        <EmptyState message="No expenses found" sub="Tap + to add your first expense" theme={theme} />
      ) : (
        Object.entries(grouped).map(([date, expenses]) => (
          <div key={date} style={{ marginBottom: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
              <span style={{ fontSize: '0.78rem', fontWeight: 600, color: theme.textSub, textTransform: 'uppercase', letterSpacing: 0.5 }}>{date}</span>
              <span style={{ fontSize: '0.78rem', color: theme.textSub }}>{formatCurrency(expenses.reduce((s, e) => s + e.amount, 0), expenses[0]?.currency || 'USD')}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {expenses.map(e => (
                <ExpenseRow key={e.id} expense={e} theme={theme}
                  onEdit={(exp) => dispatch({ type: 'OPEN_MODAL', payload: 'add_expense', expense: exp })}
                  onDelete={handleDelete} />
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

// ─── Expense Modal ────────────────────────────────────────────────────────────

function ExpenseModal() {
  const { state, dispatch, theme } = useApp();
  const editing = state.editingExpense;
  const [form, setForm] = useState({
    amount: editing?.amount || '',
    currency: editing?.currency || state.user?.base_currency || 'USD',
    merchant_name: editing?.merchant_name || '',
    category: editing?.category || '',
    notes: editing?.notes || '',
    payment_method: editing?.payment_method || 'credit_card',
    expense_date: editing?.expense_date ? new Date(editing.expense_date).toISOString().slice(0, 16) : new Date().toISOString().slice(0, 16),
    location_name: editing?.location_name || '',
    tags: editing?.tags || [],
    splits: editing?.splits || [],
  });
  const [mlSuggestion, setMlSuggestion] = useState(null);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState('basic');
  const [newTag, setNewTag] = useState('');

  useEffect(() => {
    if (form.merchant_name.length > 2 && !form.category) {
      const result = edgeCategorize(form.merchant_name + ' ' + form.notes);
      if (result) setMlSuggestion(result);
    }
  }, [form.merchant_name, form.notes]);

  const handleSave = async () => {
    if (!form.amount || isNaN(parseFloat(form.amount))) return;
    setSaving(true);
    const expense = {
      id: editing?.id || crypto.randomUUID(),
      ...form,
      amount: parseFloat(form.amount),
      base_amount: parseFloat(form.amount),
      expense_date: new Date(form.expense_date).toISOString(),
      category: form.category || mlSuggestion?.category || 'Other',
    };
    dispatch({ type: editing ? 'UPDATE_EXPENSE' : 'ADD_EXPENSE', payload: expense });
    await OfflineDB.put('expenses', expense);
    await SyncEngine.queueMutation('expense', expense.id, editing ? 'update' : 'create', expense);
    setSaving(false);
    dispatch({ type: 'CLOSE_MODAL' });
  };

  const addSplit = () => setForm(f => ({ ...f, splits: [...f.splits, { id: crypto.randomUUID(), name: '', amount: '' }] }));
  const updateSplit = (id, field, val) => setForm(f => ({ ...f, splits: f.splits.map(s => s.id === id ? { ...s, [field]: val } : s) }));
  const removeSplit = (id) => setForm(f => ({ ...f, splits: f.splits.filter(s => s.id !== id) }));
  const addTag = () => { if (newTag.trim()) { setForm(f => ({ ...f, tags: [...f.tags, newTag.trim()] })); setNewTag(''); } };

  const currencies = ['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'INR', 'SGD', 'CHF', 'CNY'];
  const methods = ['credit_card', 'debit_card', 'cash', 'digital_wallet', 'bank_transfer'];
  const methodLabels = { credit_card: '💳 Credit Card', debit_card: '🏦 Debit Card', cash: '💵 Cash', digital_wallet: '📱 Digital Wallet', bank_transfer: '🏛️ Bank Transfer' };
  const splitTotal = form.splits.reduce((s, sp) => s + (parseFloat(sp.amount) || 0), 0);
  const youPay = parseFloat(form.amount || 0) - splitTotal;

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 200, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
      <div onClick={() => dispatch({ type: 'CLOSE_MODAL' })} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.5)' }} />
      <div style={{ position: 'relative', background: theme.surface, borderRadius: '24px 24px 0 0', maxHeight: '92vh', overflow: 'hidden', display: 'flex', flexDirection: 'column' }} className="slide-up">
        <div style={{ width: 40, height: 4, background: theme.border, borderRadius: 2, margin: '12px auto 0' }} />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 20px 16px' }}>
          <h2 style={{ fontWeight: 700, fontSize: '1.1rem' }}>{editing ? 'Edit Expense' : 'Add Expense'}</h2>
          <button onClick={() => dispatch({ type: 'CLOSE_MODAL' })}
            style={{ background: theme.surfaceAlt, border: 'none', borderRadius: 20, padding: '6px 10px', color: theme.textSub }}>
            <Icon name="x" size={16} />
          </button>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 8, padding: '0 20px 16px' }}>
          {['basic', 'details', 'split'].map(t => (
            <button key={t} onClick={() => setActiveTab(t)} style={{
              padding: '6px 16px', borderRadius: 20, border: 'none', fontSize: '0.8rem',
              background: activeTab === t ? theme.primary : theme.surfaceAlt,
              color: activeTab === t ? 'white' : theme.textSub, fontWeight: 500,
            }}>{t.charAt(0).toUpperCase() + t.slice(1)}</button>
          ))}
        </div>

        <div style={{ overflowY: 'auto', padding: '0 20px', flex: 1 }}>

          {/* ── BASIC TAB ── */}
          {activeTab === 'basic' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <label style={{ fontSize: '0.78rem', fontWeight: 600, color: theme.textSub, marginBottom: 6, display: 'block' }}>AMOUNT *</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  {/* FIX: currency selector functional */}
                  <select value={form.currency} onChange={e => setForm(f => ({ ...f, currency: e.target.value }))}
                    style={{ border: `1px solid ${theme.border}`, borderRadius: 12, padding: '12px 10px', background: theme.surfaceAlt, fontSize: '0.9rem', outline: 'none' }}>
                    {currencies.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                  <input type="number" placeholder="0.00" value={form.amount}
                    onChange={e => setForm(f => ({ ...f, amount: e.target.value }))}
                    style={{ flex: 1, border: `1px solid ${theme.border}`, borderRadius: 12, padding: '12px 14px', fontSize: '1.4rem', fontWeight: 700, background: theme.surfaceAlt, outline: 'none' }}
                    inputMode="decimal" />
                </div>
                {form.amount && <div style={{ fontSize: '0.75rem', color: theme.textSub, marginTop: 4 }}>= {formatCurrency(form.amount, form.currency)}</div>}
              </div>

              <FormField label="MERCHANT / STORE" placeholder="e.g. Starbucks, Amazon..." value={form.merchant_name}
                onChange={v => setForm(f => ({ ...f, merchant_name: v }))} theme={theme} />

              {mlSuggestion && !form.category && (
                <div style={{ background: theme.primaryLight, borderRadius: 12, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span>🤖</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: '0.78rem', color: theme.primary, fontWeight: 600 }}>Suggested: {mlSuggestion.category}</div>
                    <div style={{ fontSize: '0.75rem', color: theme.textSub }}>{Math.round(mlSuggestion.confidence * 100)}% confidence</div>
                  </div>
                  <button onClick={() => setForm(f => ({ ...f, category: mlSuggestion.category }))}
                    style={{ background: theme.primary, color: 'white', border: 'none', borderRadius: 8, padding: '6px 12px', fontSize: '0.78rem', fontWeight: 600 }}>Use</button>
                </div>
              )}

              <div>
                <label style={{ fontSize: '0.78rem', fontWeight: 600, color: theme.textSub, marginBottom: 8, display: 'block' }}>CATEGORY</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {Object.keys(CAT_COLORS).map(cat => (
                    <button key={cat} onClick={() => setForm(f => ({ ...f, category: f.category === cat ? '' : cat }))}
                      style={{ padding: '6px 12px', borderRadius: 20, border: `1px solid ${form.category === cat ? CAT_COLORS[cat] : theme.border}`, background: form.category === cat ? `${CAT_COLORS[cat]}20` : theme.surfaceAlt, color: form.category === cat ? CAT_COLORS[cat] : theme.textSub, fontSize: '0.78rem', fontWeight: form.category === cat ? 600 : 400 }}>
                      {CAT_ICONS[cat]} {cat}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label style={{ fontSize: '0.78rem', fontWeight: 600, color: theme.textSub, marginBottom: 6, display: 'block' }}>DATE & TIME</label>
                <input type="datetime-local" value={form.expense_date} onChange={e => setForm(f => ({ ...f, expense_date: e.target.value }))}
                  style={{ width: '100%', border: `1px solid ${theme.border}`, borderRadius: 12, padding: '12px 14px', background: theme.surfaceAlt, fontSize: '0.9rem', outline: 'none' }} />
              </div>
            </div>
          )}

          {/* ── DETAILS TAB — FIX: full detail inputs ── */}
          {activeTab === 'details' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <label style={{ fontSize: '0.78rem', fontWeight: 600, color: theme.textSub, marginBottom: 6, display: 'block' }}>PAYMENT METHOD</label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {methods.map(m => (
                    <button key={m} onClick={() => setForm(f => ({ ...f, payment_method: m }))}
                      style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', border: `1px solid ${form.payment_method === m ? theme.primary : theme.border}`, borderRadius: 12, background: form.payment_method === m ? theme.primaryLight : theme.surfaceAlt, color: form.payment_method === m ? theme.primary : theme.text, fontWeight: form.payment_method === m ? 600 : 400, fontSize: '0.9rem' }}>
                      <span style={{ flex: 1 }}>{methodLabels[m]}</span>
                      {form.payment_method === m && <Icon name="check" size={16} color={theme.primary} />}
                    </button>
                  ))}
                </div>
              </div>

              <FormField label="LOCATION" placeholder="e.g. New York, NY" value={form.location_name}
                onChange={v => setForm(f => ({ ...f, location_name: v }))} theme={theme} />

              <div>
                <label style={{ fontSize: '0.78rem', fontWeight: 600, color: theme.textSub, marginBottom: 6, display: 'block' }}>NOTES</label>
                <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                  placeholder="Add any notes about this expense..." rows={3}
                  style={{ width: '100%', border: `1px solid ${theme.border}`, borderRadius: 12, padding: '12px 14px', background: theme.surfaceAlt, fontSize: '0.9rem', outline: 'none', resize: 'vertical' }} />
              </div>

              {/* Tags */}
              <div>
                <label style={{ fontSize: '0.78rem', fontWeight: 600, color: theme.textSub, marginBottom: 6, display: 'block' }}>TAGS</label>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                  {form.tags.map(tag => (
                    <span key={tag} style={{ fontSize: '0.78rem', padding: '4px 10px', borderRadius: 20, background: theme.primaryLight, color: theme.primary, display: 'flex', alignItems: 'center', gap: 4 }}>
                      #{tag}
                      <button onClick={() => setForm(f => ({ ...f, tags: f.tags.filter(t => t !== tag) }))}
                        style={{ background: 'none', border: 'none', color: theme.primary, padding: 0, lineHeight: 1, fontSize: 12 }}>×</button>
                    </span>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input value={newTag} onChange={e => setNewTag(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && addTag()}
                    placeholder="Add tag..." style={{ flex: 1, border: `1px solid ${theme.border}`, borderRadius: 10, padding: '8px 12px', background: theme.surfaceAlt, fontSize: '0.85rem', outline: 'none' }} />
                  <button onClick={addTag} style={{ background: theme.primary, color: 'white', border: 'none', borderRadius: 10, padding: '8px 14px', fontWeight: 600 }}>Add</button>
                </div>
              </div>
            </div>
          )}

          {/* ── SPLIT TAB — FIX: working split ── */}
          {activeTab === 'split' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ background: theme.primaryLight, borderRadius: 12, padding: 14 }}>
                <div style={{ fontSize: '0.82rem', color: theme.primary, fontWeight: 600, marginBottom: 4 }}>Split Summary</div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem' }}>
                  <span style={{ color: theme.textSub }}>Total:</span>
                  <span style={{ fontWeight: 700 }}>{formatCurrency(form.amount || 0, form.currency)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', marginTop: 4 }}>
                  <span style={{ color: theme.textSub }}>Others pay:</span>
                  <span style={{ fontWeight: 600, color: theme.warning }}>{formatCurrency(splitTotal, form.currency)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', marginTop: 4 }}>
                  <span style={{ color: theme.textSub }}>You pay:</span>
                  <span style={{ fontWeight: 700, color: youPay >= 0 ? theme.success : theme.danger }}>{formatCurrency(youPay, form.currency)}</span>
                </div>
              </div>

              {form.splits.map(split => (
                <div key={split.id} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <div style={{ flex: 1 }}>
                    <input value={split.name} onChange={e => updateSplit(split.id, 'name', e.target.value)}
                      placeholder="Person's name" style={{ width: '100%', border: `1px solid ${theme.border}`, borderRadius: 10, padding: '10px 12px', background: theme.surfaceAlt, fontSize: '0.88rem', outline: 'none' }} />
                  </div>
                  <div style={{ width: 100 }}>
                    <input type="number" value={split.amount} onChange={e => updateSplit(split.id, 'amount', e.target.value)}
                      placeholder="Amount" inputMode="decimal"
                      style={{ width: '100%', border: `1px solid ${theme.border}`, borderRadius: 10, padding: '10px 12px', background: theme.surfaceAlt, fontSize: '0.88rem', outline: 'none' }} />
                  </div>
                  <button onClick={() => removeSplit(split.id)} style={{ background: `${theme.danger}15`, border: 'none', borderRadius: 10, padding: '10px', color: theme.danger }}>
                    <Icon name="x" size={14} color={theme.danger} />
                  </button>
                </div>
              ))}

              {form.splits.length === 0 && (
                <div style={{ textAlign: 'center', padding: '16px 0', color: theme.textSub }}>
                  <div style={{ fontSize: 32, marginBottom: 8 }}>👥</div>
                  <div style={{ fontSize: '0.85rem' }}>No splits added yet</div>
                </div>
              )}

              <button onClick={addSplit}
                style={{ padding: '12px', borderRadius: 12, border: `2px dashed ${theme.primary}`, background: theme.primaryLight, color: theme.primary, fontWeight: 600, fontSize: '0.9rem' }}>
                + Add Person to Split
              </button>

              {form.splits.length > 0 && (
                <button onClick={() => {
                  const each = parseFloat(form.amount || 0) / (form.splits.length + 1);
                  setForm(f => ({ ...f, splits: f.splits.map(s => ({ ...s, amount: each.toFixed(2) })) }));
                }} style={{ padding: '10px', borderRadius: 12, border: `1px solid ${theme.border}`, background: theme.surfaceAlt, color: theme.text, fontSize: '0.85rem' }}>
                  ⚡ Split Equally ({form.splits.length + 1} people)
                </button>
              )}
            </div>
          )}
        </div>

        <div style={{ padding: '16px 20px 0' }}>
          <button onClick={handleSave} disabled={saving || !form.amount}
            style={{ width: '100%', padding: '16px', background: form.amount ? theme.primary : theme.border, color: 'white', border: 'none', borderRadius: 16, fontSize: '1rem', fontWeight: 700, opacity: saving ? 0.7 : 1 }}>
            {saving ? '⏳ Saving...' : editing ? '✓ Update Expense' : '+ Add Expense'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Budgets Screen ────────────────────────────────────────────────────────────

function BudgetsScreen() {
  const { state, dispatch, theme } = useApp();
  return (
    <div style={{ padding: 16 }} className="fade-in">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ fontWeight: 700 }}>Your Budgets</h2>
        {/* FIX: + New button opens modal */}
        <button onClick={() => dispatch({ type: 'OPEN_MODAL', payload: 'add_budget' })}
          style={{ background: theme.primary, color: 'white', border: 'none', borderRadius: 12, padding: '8px 16px', fontSize: '0.85rem', fontWeight: 600 }}>
          + New
        </button>
      </div>

      {state.budgets.length === 0 ? (
        <EmptyState message="No budgets yet" sub="Tap + New to create your first budget" theme={theme} />
      ) : (
        state.budgets.map(budget => {
          const pct = Math.min(100, ((budget.spent || 0) / budget.amount) * 100);
          const color = pct > 90 ? theme.danger : pct > 70 ? theme.warning : theme.success;
          const remaining = budget.amount - (budget.spent || 0);
          return (
            <div key={budget.id} style={{ background: theme.surface, borderRadius: 16, padding: 16, marginBottom: 12, border: `1px solid ${theme.border}` }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: '1rem' }}>{CAT_ICONS[budget.category] || '🎯'} {budget.name}</div>
                  <div style={{ fontSize: '0.78rem', color: theme.textSub, marginTop: 2 }}>{budget.category}</div>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontWeight: 700, color, fontSize: '1.1rem' }}>{pct.toFixed(0)}%</div>
                    <div style={{ fontSize: '0.68rem', color: theme.textSub }}>used</div>
                  </div>
                  <button onClick={() => { if (window.confirm('Delete this budget?')) dispatch({ type: 'DELETE_BUDGET', id: budget.id }); }}
                    style={{ background: 'none', border: 'none', color: theme.danger, padding: 4 }}>
                    <Icon name="trash" size={15} color={theme.danger} />
                  </button>
                </div>
              </div>
              <div style={{ height: 10, background: theme.border, borderRadius: 5, overflow: 'hidden', marginBottom: 12 }}>
                <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 5, transition: 'width 0.5s' }} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem' }}>
                <span>Spent: <strong style={{ color: theme.text }}>{formatCurrency(budget.spent || 0, budget.currency)}</strong></span>
                <span>Left: <strong style={{ color: remaining >= 0 ? theme.success : theme.danger }}>{formatCurrency(Math.abs(remaining), budget.currency)}{remaining < 0 ? ' over' : ''}</strong></span>
                <span>Limit: <strong style={{ color: theme.text }}>{formatCurrency(budget.amount, budget.currency)}</strong></span>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

// ─── Budget Modal — FIX: working new budget creation ─────────────────────────

function BudgetModal() {
  const { state, dispatch, theme } = useApp();
  const [form, setForm] = useState({ name: '', amount: '', currency: state.user?.base_currency || 'USD', category: '', period: 'monthly' });
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!form.name || !form.amount || isNaN(parseFloat(form.amount))) return;
    setSaving(true);
    const budget = {
      id: crypto.randomUUID(),
      name: form.name,
      amount: parseFloat(form.amount),
      currency: form.currency,
      category: form.category || 'Other',
      spent: 0,
      period: form.period,
      period_start: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString(),
    };
    dispatch({ type: 'ADD_BUDGET', payload: budget });
    await OfflineDB.put('budgets', budget);
    setSaving(false);
    dispatch({ type: 'CLOSE_MODAL' });
  };

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 200, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
      <div onClick={() => dispatch({ type: 'CLOSE_MODAL' })} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.5)' }} />
      <div style={{ position: 'relative', background: theme.surface, borderRadius: '24px 24px 0 0', padding: '0 0 24px', display: 'flex', flexDirection: 'column' }} className="slide-up">
        <div style={{ width: 40, height: 4, background: theme.border, borderRadius: 2, margin: '12px auto 0' }} />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 20px 20px' }}>
          <h2 style={{ fontWeight: 700 }}>Create Budget</h2>
          <button onClick={() => dispatch({ type: 'CLOSE_MODAL' })} style={{ background: theme.surfaceAlt, border: 'none', borderRadius: 20, padding: '6px 10px' }}>
            <Icon name="x" size={16} color={theme.textSub} />
          </button>
        </div>
        <div style={{ padding: '0 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <FormField label="BUDGET NAME" placeholder="e.g. Monthly Food" value={form.name} onChange={v => setForm(f => ({ ...f, name: v }))} theme={theme} />
          <div>
            <label style={{ fontSize: '0.78rem', fontWeight: 600, color: theme.textSub, marginBottom: 6, display: 'block' }}>LIMIT AMOUNT</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <select value={form.currency} onChange={e => setForm(f => ({ ...f, currency: e.target.value }))}
                style={{ border: `1px solid ${theme.border}`, borderRadius: 12, padding: '12px 10px', background: theme.surfaceAlt, outline: 'none' }}>
                {['USD','EUR','GBP','JPY','CAD','AUD','INR','SGD','CHF','CNY'].map(c => <option key={c} value={c}>{c}</option>)}
              </select>
              <input type="number" placeholder="0.00" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))}
                style={{ flex: 1, border: `1px solid ${theme.border}`, borderRadius: 12, padding: '12px 14px', fontSize: '1.2rem', fontWeight: 700, background: theme.surfaceAlt, outline: 'none' }} inputMode="decimal" />
            </div>
          </div>
          <div>
            <label style={{ fontSize: '0.78rem', fontWeight: 600, color: theme.textSub, marginBottom: 8, display: 'block' }}>CATEGORY</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {Object.keys(CAT_COLORS).map(cat => (
                <button key={cat} onClick={() => setForm(f => ({ ...f, category: f.category === cat ? '' : cat }))}
                  style={{ padding: '6px 12px', borderRadius: 20, border: `1px solid ${form.category === cat ? CAT_COLORS[cat] : theme.border}`, background: form.category === cat ? `${CAT_COLORS[cat]}20` : theme.surfaceAlt, color: form.category === cat ? CAT_COLORS[cat] : theme.textSub, fontSize: '0.78rem', fontWeight: form.category === cat ? 600 : 400 }}>
                  {CAT_ICONS[cat]} {cat}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label style={{ fontSize: '0.78rem', fontWeight: 600, color: theme.textSub, marginBottom: 8, display: 'block' }}>PERIOD</label>
            <div style={{ display: 'flex', gap: 8 }}>
              {['weekly', 'monthly', 'yearly'].map(p => (
                <button key={p} onClick={() => setForm(f => ({ ...f, period: p }))}
                  style={{ flex: 1, padding: '10px', borderRadius: 12, border: `1px solid ${form.period === p ? theme.primary : theme.border}`, background: form.period === p ? theme.primaryLight : theme.surfaceAlt, color: form.period === p ? theme.primary : theme.textSub, fontWeight: form.period === p ? 600 : 400, fontSize: '0.82rem' }}>
                  {p.charAt(0).toUpperCase() + p.slice(1)}
                </button>
              ))}
            </div>
          </div>
          <button onClick={handleSave} disabled={saving || !form.name || !form.amount}
            style={{ width: '100%', padding: '16px', background: (form.name && form.amount) ? theme.primary : theme.border, color: 'white', border: 'none', borderRadius: 16, fontSize: '1rem', fontWeight: 700, marginTop: 4, opacity: saving ? 0.7 : 1 }}>
            {saving ? '⏳ Creating...' : '+ Create Budget'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Analytics Screen — FIX: real insights from data ─────────────────────────

function AnalyticsScreen() {
  const { state, theme } = useApp();
  const currency = state.user?.base_currency || 'USD';

  const byCategory = state.expenses.reduce((acc, e) => {
    const cat = e.category || 'Other'; acc[cat] = (acc[cat] || 0) + (e.base_amount || 0); return acc;
  }, {});
  const total = Object.values(byCategory).reduce((s, v) => s + v, 0);
  const sorted = Object.entries(byCategory).sort((a, b) => b[1] - a[1]);

  // Weekly bar
  const weekData = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(); d.setDate(d.getDate() - (6 - i));
    const dayTotal = state.expenses.filter(e => {
      const ed = new Date(e.expense_date);
      return ed.getDate() === d.getDate() && ed.getMonth() === d.getMonth();
    }).reduce((s, e) => s + e.base_amount, 0);
    return { label: d.toLocaleDateString('en-US', { weekday: 'short' }), value: dayTotal };
  });
  const maxDay = Math.max(...weekData.map(d => d.value), 1);

  // FIX: Real spending insights based on actual data
  const insights = generateInsights(state.expenses, state.budgets, currency);

  // Monthly comparison
  const now = new Date();
  const thisMonthExpenses = state.expenses.filter(e => {
    const d = new Date(e.expense_date);
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  });
  const lastMonthExpenses = state.expenses.filter(e => {
    const d = new Date(e.expense_date);
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1);
    return d.getMonth() === lastMonth.getMonth() && d.getFullYear() === lastMonth.getFullYear();
  });
  const thisMonthTotal = thisMonthExpenses.reduce((s, e) => s + e.base_amount, 0);
  const lastMonthTotal = lastMonthExpenses.reduce((s, e) => s + e.base_amount, 0);
  const monthChange = lastMonthTotal > 0 ? ((thisMonthTotal - lastMonthTotal) / lastMonthTotal * 100) : 0;

  return (
    <div style={{ padding: 16 }} className="fade-in">
      <h2 style={{ fontWeight: 700, marginBottom: 16 }}>Spending Insights</h2>

      {/* Month comparison */}
      <Card theme={theme} style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: '0.78rem', color: theme.textSub, marginBottom: 4 }}>This Month</div>
            <div style={{ fontSize: '1.4rem', fontWeight: 700 }}>{formatCurrency(thisMonthTotal, currency)}</div>
            <div style={{ fontSize: '0.78rem', color: monthChange > 0 ? theme.danger : theme.success, marginTop: 4, fontWeight: 600 }}>
              {monthChange > 0 ? '↑' : '↓'} {Math.abs(monthChange).toFixed(0)}% vs last month
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '0.78rem', color: theme.textSub, marginBottom: 4 }}>Last Month</div>
            <div style={{ fontSize: '1.1rem', fontWeight: 600, color: theme.textSub }}>{formatCurrency(lastMonthTotal, currency)}</div>
          </div>
        </div>
      </Card>

      {/* Weekly chart */}
      <Card theme={theme} style={{ marginBottom: 16 }}>
        <h3 style={{ fontSize: '0.95rem', fontWeight: 600, marginBottom: 14 }}>Last 7 Days</h3>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, height: 100 }}>
          {weekData.map((d, i) => (
            <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
              <div style={{ width: '100%', height: `${(d.value / maxDay) * 80}px`, minHeight: d.value > 0 ? 4 : 0, background: d.value > 0 ? theme.primary : theme.border, borderRadius: 4 }} />
              <span style={{ fontSize: '0.65rem', color: theme.textSub }}>{d.label}</span>
              {d.value > 0 && <span style={{ fontSize: '0.6rem', color: theme.primary, fontWeight: 600 }}>{formatCurrency(d.value, currency)}</span>}
            </div>
          ))}
        </div>
      </Card>

      {/* Donut chart */}
      <Card theme={theme} style={{ marginBottom: 16 }}>
        <h3 style={{ fontSize: '0.95rem', fontWeight: 600, marginBottom: 14 }}>Category Breakdown</h3>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          <div style={{ position: 'relative', width: 100, height: 100, flexShrink: 0 }}>
            <svg viewBox="0 0 36 36" style={{ width: 100, height: 100, transform: 'rotate(-90deg)' }}>
              {(() => { let offset = 0; return sorted.slice(0, 6).map(([cat, val]) => { const pct = (val / total) * 100; const color = CAT_COLORS[cat] || '#9CA3AF'; const el = (<circle key={cat} r="15.9155" cx="18" cy="18" fill="none" stroke={color} strokeWidth="3.5" strokeDasharray={`${pct} ${100 - pct}`} strokeDashoffset={-offset} />); offset += pct; return el; }); })()}
            </svg>
            <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
              <span style={{ fontSize: '0.65rem', color: theme.textSub }}>Total</span>
              <span style={{ fontSize: '0.8rem', fontWeight: 700 }}>{formatCurrency(total, currency)}</span>
            </div>
          </div>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {sorted.slice(0, 5).map(([cat, val]) => (
              <div key={cat} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ width: 10, height: 10, borderRadius: 2, background: CAT_COLORS[cat] || '#9CA3AF', flexShrink: 0 }} />
                <span style={{ fontSize: '0.75rem', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cat}</span>
                <span style={{ fontSize: '0.72rem', color: theme.textSub, fontWeight: 600 }}>{total > 0 ? ((val / total) * 100).toFixed(0) : 0}%</span>
              </div>
            ))}
          </div>
        </div>
      </Card>

      {/* FIX: Real insights from data */}
      {insights.map((insight, i) => (
        <div key={i} style={{ background: `${insight.color}15`, border: `1px solid ${insight.color}40`, borderRadius: 16, padding: 14, marginBottom: 12, display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          <span style={{ fontSize: 20 }}>{insight.emoji}</span>
          <div>
            <div style={{ fontWeight: 600, fontSize: '0.9rem', marginBottom: 4 }}>{insight.title}</div>
            <div style={{ fontSize: '0.8rem', color: theme.textSub }}>{insight.body}</div>
          </div>
        </div>
      ))}

      {/* Top merchants */}
      <Card theme={theme}>
        <h3 style={{ fontSize: '0.95rem', fontWeight: 600, marginBottom: 12 }}>Top Merchants</h3>
        {Object.entries(state.expenses.reduce((acc, e) => {
          const m = e.merchant_name || 'Unknown'; acc[m] = (acc[m] || 0) + e.amount; return acc;
        }, {})).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([m, v]) => (
          <div key={m} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: `1px solid ${theme.border}` }}>
            <span style={{ fontSize: '0.85rem' }}>{m}</span>
            <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>{formatCurrency(v, currency)}</span>
          </div>
        ))}
      </Card>
    </div>
  );
}

// FIX: Real insights generator
function generateInsights(expenses, budgets, currency) {
  const insights = [];
  if (!expenses.length) return [{ emoji: '💡', title: 'Start Tracking', body: 'Add your first expense to see personalized spending insights here.', color: '#6366F1' }];

  const now = new Date();
  const thisMonth = expenses.filter(e => { const d = new Date(e.expense_date); return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear(); });
  const lastMonth = expenses.filter(e => { const d = new Date(e.expense_date); const lm = new Date(now.getFullYear(), now.getMonth() - 1); return d.getMonth() === lm.getMonth() && d.getFullYear() === lm.getFullYear(); });

  const byCategory = (list) => list.reduce((acc, e) => { const c = e.category || 'Other'; acc[c] = (acc[c] || 0) + e.base_amount; return acc; }, {});
  const thisCats = byCategory(thisMonth);
  const lastCats = byCategory(lastMonth);

  // Biggest increase category
  for (const [cat, amount] of Object.entries(thisCats)) {
    const last = lastCats[cat] || 0;
    if (last > 0 && amount > last * 1.2) {
      insights.push({ emoji: '📈', title: `${cat} spending up`, body: `Your ${cat} spending increased by ${((amount - last) / last * 100).toFixed(0)}% this month (${formatCurrency(amount, currency)} vs ${formatCurrency(last, currency)} last month).`, color: '#F59E0B' });
      break;
    }
  }

  // Budget warnings
  for (const budget of budgets) {
    const pct = ((budget.spent || 0) / budget.amount) * 100;
    if (pct > 90) {
      insights.push({ emoji: '🚨', title: `${budget.name} almost full`, body: `You've used ${pct.toFixed(0)}% of your ${budget.name} budget. Only ${formatCurrency(budget.amount - (budget.spent || 0), budget.currency)} remaining.`, color: '#EF4444' });
    } else if (pct > 70) {
      insights.push({ emoji: '⚠️', title: `${budget.name} at ${pct.toFixed(0)}%`, body: `Consider slowing down spending in ${budget.category}. You have ${formatCurrency(budget.amount - (budget.spent || 0), budget.currency)} left.`, color: '#F59E0B' });
    }
  }

  // Top category this month
  const topCat = Object.entries(thisCats).sort((a, b) => b[1] - a[1])[0];
  if (topCat) {
    const totalThis = thisMonth.reduce((s, e) => s + e.base_amount, 0);
    const pct = totalThis > 0 ? (topCat[1] / totalThis * 100).toFixed(0) : 0;
    insights.push({ emoji: '🏆', title: `Top category: ${topCat[0]}`, body: `${topCat[0]} accounts for ${pct}% of your spending this month at ${formatCurrency(topCat[1], currency)}.`, color: CAT_COLORS[topCat[0]] || '#6366F1' });
  }

  // Frequent small purchases
  const smallPurchases = expenses.filter(e => e.amount < 10);
  if (smallPurchases.length >= 5) {
    const smallTotal = smallPurchases.reduce((s, e) => s + e.amount, 0);
    insights.push({ emoji: '☕', title: 'Small purchases add up', body: `You have ${smallPurchases.length} purchases under $10, totaling ${formatCurrency(smallTotal, currency)}. Small daily habits have a big impact!`, color: '#06B6D4' });
  }

  return insights.slice(0, 3);
}

// ─── Settings Screen — FIX: all settings working ─────────────────────────────

function SettingsScreen() {
  const { state, dispatch, theme } = useApp();
  const [editingName, setEditingName] = useState(false);
  const [editingCurrency, setEditingCurrency] = useState(false);
  const [newName, setNewName] = useState(state.user?.display_name || '');
  const isRealUser = state.user && !state.user.isDemo;

  const handleNameSave = () => {
    if (newName.trim()) dispatch({ type: 'UPDATE_USER', payload: { display_name: newName.trim() } });
    setEditingName(false);
  };

  const exportCSV = () => {
    const headers = ['Date', 'Merchant', 'Category', 'Amount', 'Currency', 'Payment Method', 'Notes', 'Tags'];
    const rows = state.expenses.map(e => [
      new Date(e.expense_date).toLocaleDateString(),
      e.merchant_name || '',
      e.category || '',
      e.amount,
      e.currency || 'USD',
      e.payment_method || '',
      (e.notes || '').replace(/,/g, ';'),
      (e.tags || []).join(';'),
    ]);
    const csv = [headers, ...rows].map(r => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `spendwise-export-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  const exportJSON = () => {
    const data = { expenses: state.expenses, budgets: state.budgets, exported_at: new Date().toISOString() };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `spendwise-backup-${new Date().toISOString().slice(0, 10)}.json`; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div style={{ padding: 16 }} className="fade-in">
      <h2 style={{ fontWeight: 700, marginBottom: 20 }}>Settings</h2>

      {/* FIX: Sign-in section */}
      {!isRealUser && (
        <div style={{ background: `${theme.primary}15`, border: `1px solid ${theme.primary}30`, borderRadius: 16, padding: 16, marginBottom: 20, display: 'flex', gap: 14, alignItems: 'center' }}>
          <div style={{ fontSize: 36 }}>☁️</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: '0.95rem', marginBottom: 4 }}>Sign in to sync</div>
            <div style={{ fontSize: '0.8rem', color: theme.textSub }}>Sign in to back up your data and sync across devices.</div>
          </div>
          <button onClick={() => dispatch({ type: 'OPEN_MODAL', payload: 'signin' })}
            style={{ background: theme.primary, color: 'white', border: 'none', borderRadius: 12, padding: '10px 16px', fontWeight: 600, fontSize: '0.85rem', whiteSpace: 'nowrap' }}>
            Sign In
          </button>
        </div>
      )}

      {/* Appearance */}
      <SettingsSection title="APPEARANCE" theme={theme}>
        <SettingsRow label="Theme" theme={theme}>
          <div style={{ display: 'flex', gap: 8 }}>
            {['light', 'dark'].map(t => (
              <button key={t} onClick={() => dispatch({ type: 'SET_THEME', payload: t })}
                style={{ padding: '6px 14px', borderRadius: 20, border: `1px solid ${state.theme === t ? theme.primary : theme.border}`, background: state.theme === t ? theme.primary : theme.surfaceAlt, color: state.theme === t ? 'white' : theme.textSub, fontSize: '0.8rem', fontWeight: 500 }}>
                {t === 'light' ? '☀️ Light' : '🌙 Dark'}
              </button>
            ))}
          </div>
        </SettingsRow>
        <SettingsRow label="Color Scheme" theme={theme}>
          <div style={{ display: 'flex', gap: 10 }}>
            {Object.entries(COLOR_SCHEMES).map(([name, scheme]) => (
              <button key={name} onClick={() => dispatch({ type: 'SET_COLOR', payload: name })}
                style={{ width: 28, height: 28, borderRadius: '50%', background: scheme.primary, border: state.colorScheme === name ? `3px solid ${theme.text}` : '2px solid transparent', cursor: 'pointer' }} />
            ))}
          </div>
        </SettingsRow>
        <SettingsRow label="Text Size" theme={theme}>
          <div style={{ display: 'flex', gap: 6 }}>
            {['sm', 'md', 'lg', 'xl'].map(s => (
              <button key={s} onClick={() => dispatch({ type: 'SET_FONTSIZE', payload: s })}
                style={{ width: 36, height: 36, borderRadius: 8, border: `1px solid ${state.fontSize === s ? theme.primary : theme.border}`, background: state.fontSize === s ? theme.primaryLight : theme.surfaceAlt, color: state.fontSize === s ? theme.primary : theme.textSub, fontSize: { sm: '0.7rem', md: '0.85rem', lg: '1rem', xl: '1.1rem' }[s], fontWeight: 600 }}>A</button>
            ))}
          </div>
        </SettingsRow>
      </SettingsSection>

      {/* FIX: Account — shows actual user data, editable */}
      <SettingsSection title="ACCOUNT" theme={theme}>
        <SettingsRow label="Name" theme={theme}>
          {editingName ? (
            <div style={{ display: 'flex', gap: 8 }}>
              <input value={newName} onChange={e => setNewName(e.target.value)} autoFocus
                style={{ border: `1px solid ${theme.primary}`, borderRadius: 8, padding: '4px 10px', background: theme.surfaceAlt, fontSize: '0.85rem', outline: 'none', width: 130 }} />
              <button onClick={handleNameSave} style={{ background: theme.primary, color: 'white', border: 'none', borderRadius: 8, padding: '4px 10px', fontSize: '0.8rem', fontWeight: 600 }}>Save</button>
              <button onClick={() => setEditingName(false)} style={{ background: 'none', border: 'none', color: theme.textSub, fontSize: '0.8rem' }}>Cancel</button>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <span style={{ fontSize: '0.85rem', color: theme.textSub }}>{state.user?.display_name || 'Not set'}</span>
              <button onClick={() => { setNewName(state.user?.display_name || ''); setEditingName(true); }}
                style={{ background: 'none', border: 'none', color: theme.primary, fontSize: '0.78rem' }}>Edit</button>
            </div>
          )}
        </SettingsRow>
        <SettingsRow label="Email" value={state.user?.email || 'Not set'} theme={theme} />
        <SettingsRow label="Base Currency" theme={theme}>
          {editingCurrency ? (
            <div style={{ display: 'flex', gap: 8 }}>
              <select value={state.user?.base_currency || 'USD'}
                onChange={e => { dispatch({ type: 'UPDATE_USER', payload: { base_currency: e.target.value } }); setEditingCurrency(false); }}
                style={{ border: `1px solid ${theme.primary}`, borderRadius: 8, padding: '4px 8px', background: theme.surfaceAlt, outline: 'none', fontSize: '0.85rem' }}>
                {['USD','EUR','GBP','JPY','CAD','AUD','INR','SGD','CHF','CNY'].map(c => <option key={c} value={c}>{c}</option>)}
              </select>
              <button onClick={() => setEditingCurrency(false)} style={{ background: 'none', border: 'none', color: theme.textSub, fontSize: '0.8rem' }}>Done</button>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <span style={{ fontSize: '0.85rem', color: theme.textSub }}>{state.user?.base_currency || 'USD'}</span>
              <button onClick={() => setEditingCurrency(true)} style={{ background: 'none', border: 'none', color: theme.primary, fontSize: '0.78rem' }}>Change</button>
            </div>
          )}
        </SettingsRow>
      </SettingsSection>

      {/* FIX: Toggleable privacy settings */}
      <SettingsSection title="PRIVACY & SECURITY" theme={theme}>
        <SettingsRow label="Offline Backup" theme={theme}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: '0.75rem', color: state.offlineBackupEnabled ? theme.success : theme.textSub }}>
              {state.offlineBackupEnabled ? '🔒 Encrypted' : 'Disabled'}
            </span>
            <Toggle on={state.offlineBackupEnabled} onToggle={() => dispatch({ type: 'TOGGLE_OFFLINE_BACKUP' })} theme={theme} />
          </div>
        </SettingsRow>
        <SettingsRow label="Data Collection" theme={theme}>
          <span style={{ fontSize: '0.78rem', color: theme.textSub }}>GDPR Compliant</span>
        </SettingsRow>
        <SettingsRow label="Cloud Sync" theme={theme}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: '0.75rem', color: state.cloudSyncEnabled ? theme.success : theme.textSub }}>
              {state.cloudSyncEnabled ? 'On' : 'Off'}
            </span>
            <Toggle on={state.cloudSyncEnabled} onToggle={() => dispatch({ type: 'TOGGLE_CLOUD_SYNC' })} theme={theme} />
          </div>
        </SettingsRow>
      </SettingsSection>

      {/* FIX: Working export */}
      <SettingsSection title="DATA" theme={theme}>
        <SettingsRow label="Export CSV" theme={theme}>
          <button onClick={exportCSV} style={{ background: 'none', border: 'none', color: theme.primary, fontSize: '0.85rem', fontWeight: 600 }}>
            ⬇️ Export
          </button>
        </SettingsRow>
        <SettingsRow label="Export JSON Backup" theme={theme}>
          <button onClick={exportJSON} style={{ background: 'none', border: 'none', color: theme.primary, fontSize: '0.85rem', fontWeight: 600 }}>
            ⬇️ Export
          </button>
        </SettingsRow>
        <SettingsRow label="Total Expenses" value={state.expenses.length} theme={theme} />
      </SettingsSection>

      <div style={{ padding: '16px 0', textAlign: 'center' }}>
        <div style={{ fontSize: '0.72rem', color: theme.textSub, marginBottom: 16 }}>
          SpendWise v1.0.0 · No banking credentials stored<br />
          GDPR & DPDP Compliant · AES-256 encrypted
        </div>
        <button onClick={() => dispatch({ type: 'LOGOUT' })}
          style={{ color: theme.danger, background: 'none', border: `1px solid ${theme.danger}`, borderRadius: 12, padding: '10px 24px', fontWeight: 600 }}>
          Sign Out
        </button>
      </div>
    </div>
  );
}

function SettingsSection({ title, children, theme }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ fontSize: '0.7rem', fontWeight: 700, color: theme.textSub, letterSpacing: 1, marginBottom: 10, textTransform: 'uppercase' }}>{title}</div>
      <div style={{ background: theme.surface, borderRadius: 16, border: `1px solid ${theme.border}`, overflow: 'hidden' }}>
        {children}
      </div>
    </div>
  );
}

function SettingsRow({ label, value, children, theme }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 16px', borderBottom: `1px solid ${theme.border}` }}>
      <span style={{ fontSize: '0.9rem' }}>{label}</span>
      {children || <span style={{ fontSize: '0.85rem', color: theme.textSub }}>{value}</span>}
    </div>
  );
}

// ─── Notifications — FIX: swipe to dismiss ────────────────────────────────────

function NotificationsPanel() {
  const { state, dispatch, theme } = useApp();

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 200, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
      <div onClick={() => dispatch({ type: 'CLOSE_MODAL' })} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.5)' }} />
      <div style={{ position: 'relative', background: theme.surface, borderRadius: '24px 24px 0 0', maxHeight: '75vh', overflow: 'hidden', display: 'flex', flexDirection: 'column' }} className="slide-up">
        <div style={{ width: 40, height: 4, background: theme.border, borderRadius: 2, margin: '12px auto 0' }} />
        <div style={{ display: 'flex', justifyContent: 'space-between', padding: '12px 20px 16px', alignItems: 'center' }}>
          <h2 style={{ fontWeight: 700 }}>Notifications</h2>
          <button onClick={() => dispatch({ type: 'SET_NOTIFICATIONS', payload: [] })}
            style={{ background: 'none', border: 'none', color: theme.primary, fontWeight: 600, fontSize: '0.85rem' }}>
            Clear all
          </button>
        </div>
        <div style={{ overflowY: 'auto', padding: '0 16px 24px' }}>
          {state.notifications.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 32, color: theme.textSub }}>
              <div style={{ fontSize: 40, marginBottom: 8 }}>🔔</div>
              <div>No notifications</div>
            </div>
          ) : (
            state.notifications.map(n => (
              <SwipeableNotification key={n.id} notification={n} theme={theme}
                onDismiss={() => dispatch({ type: 'DISMISS_NOTIFICATION', id: n.id })} />
            ))
          )}
          <div style={{ textAlign: 'center', marginTop: 8 }}>
            <span style={{ fontSize: '0.72rem', color: theme.textSub }}>← Swipe left to dismiss</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// FIX: Swipeable notification item
function SwipeableNotification({ notification: n, onDismiss, theme }) {
  const [startX, setStartX] = useState(null);
  const [offsetX, setOffsetX] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  const handleTouchStart = (e) => setStartX(e.touches[0].clientX);
  const handleTouchMove = (e) => {
    if (startX === null) return;
    const diff = e.touches[0].clientX - startX;
    if (diff < 0) setOffsetX(diff);
  };
  const handleTouchEnd = () => {
    if (offsetX < -80) {
      setDismissed(true);
      setTimeout(onDismiss, 300);
    } else {
      setOffsetX(0);
    }
    setStartX(null);
  };

  return (
    <div
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      style={{
        display: 'flex', gap: 14, padding: 14, background: theme.surfaceAlt,
        borderRadius: 14, marginBottom: 10, transform: `translateX(${dismissed ? -400 : offsetX}px)`,
        opacity: dismissed ? 0 : Math.max(0.3, 1 + offsetX / 200),
        transition: dismissed ? 'all 0.3s ease' : startX ? 'none' : 'transform 0.2s ease',
        position: 'relative', overflow: 'hidden', cursor: 'grab',
      }}>
      {/* Dismiss hint background */}
      {offsetX < -20 && (
        <div style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: Math.min(80, -offsetX), background: theme.danger, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '0 14px 14px 0' }}>
          <Icon name="trash" size={18} color="white" />
        </div>
      )}
      <span style={{ fontSize: 24, flexShrink: 0 }}>{n.icon}</span>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>{n.title}</div>
        <div style={{ fontSize: '0.8rem', color: theme.textSub, marginTop: 2 }}>{n.body}</div>
        <div style={{ fontSize: '0.72rem', color: theme.textSub, marginTop: 6 }}>{n.time}</div>
      </div>
      <button onClick={onDismiss} style={{ background: 'none', border: 'none', color: theme.textSub, padding: 4, alignSelf: 'flex-start' }}>
        <Icon name="x" size={14} color={theme.textSub} />
      </button>
    </div>
  );
}

// ─── Sign In Modal — FIX: new ─────────────────────────────────────────────────

function SignInModal() {
  const { dispatch, theme } = useApp();
  const [form, setForm] = useState({ email: '', password: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [mode, setMode] = useState('login'); // 'login' | 'register'

  const handleSubmit = async () => {
    if (!form.email || !form.password) { setError('Please fill in all fields'); return; }
    setLoading(true); setError('');
    try {
      const endpoint = mode === 'login' ? '/auth/login' : '/auth/register';
      const body = mode === 'login'
        ? { username: form.email, password: form.password }
        : { email: form.email, password: form.password, display_name: form.email.split('@')[0] };

      const res = await fetch(`${SyncEngine.BASE_URL}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': mode === 'login' ? 'application/x-www-form-urlencoded' : 'application/json' },
        body: mode === 'login' ? new URLSearchParams(body) : JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || data.error || 'Authentication failed');

      const token = data.access_token;
      localStorage.setItem('sw_access_token', token);

      // Get user profile
      const profileRes = await fetch(`${SyncEngine.BASE_URL}/users/me`, { headers: { Authorization: `Bearer ${token}` } });
      const profile = await profileRes.json();

      dispatch({ type: 'SET_USER', payload: { ...profile, isDemo: false }, token });
      dispatch({ type: 'CLOSE_MODAL' });
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 200, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
      <div onClick={() => dispatch({ type: 'CLOSE_MODAL' })} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.5)' }} />
      <div style={{ position: 'relative', background: theme.surface, borderRadius: '24px 24px 0 0', padding: '0 0 32px', display: 'flex', flexDirection: 'column' }} className="slide-up">
        <div style={{ width: 40, height: 4, background: theme.border, borderRadius: 2, margin: '12px auto 0' }} />
        <div style={{ padding: '16px 20px 24px', textAlign: 'center' }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>🔐</div>
          <h2 style={{ fontWeight: 700, fontSize: '1.2rem' }}>{mode === 'login' ? 'Sign In' : 'Create Account'}</h2>
          <p style={{ fontSize: '0.85rem', color: theme.textSub, marginTop: 4 }}>Sync your data across all devices</p>
        </div>
        <div style={{ padding: '0 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <FormField label="EMAIL" placeholder="you@example.com" value={form.email} onChange={v => setForm(f => ({ ...f, email: v }))} theme={theme} type="email" />
          <FormField label="PASSWORD" placeholder="••••••••" value={form.password} onChange={v => setForm(f => ({ ...f, password: v }))} theme={theme} type="password" />

          {error && (
            <div style={{ background: `${theme.danger}15`, border: `1px solid ${theme.danger}30`, borderRadius: 10, padding: '10px 14px', fontSize: '0.82rem', color: theme.danger }}>
              {error}
            </div>
          )}

          <button onClick={handleSubmit} disabled={loading}
            style={{ width: '100%', padding: '16px', background: theme.primary, color: 'white', border: 'none', borderRadius: 16, fontSize: '1rem', fontWeight: 700, opacity: loading ? 0.7 : 1 }}>
            {loading ? '⏳ Please wait...' : mode === 'login' ? '🔓 Sign In' : '✨ Create Account'}
          </button>

          <div style={{ textAlign: 'center' }}>
            <button onClick={() => { setMode(m => m === 'login' ? 'register' : 'login'); setError(''); }}
              style={{ background: 'none', border: 'none', color: theme.primary, fontSize: '0.85rem', fontWeight: 600 }}>
              {mode === 'login' ? "Don't have an account? Sign up" : 'Already have an account? Sign in'}
            </button>
          </div>

          <button onClick={() => dispatch({ type: 'CLOSE_MODAL' })}
            style={{ background: 'none', border: 'none', color: theme.textSub, fontSize: '0.85rem', textDecoration: 'underline' }}>
            Continue without signing in
          </button>
        </div>
      </div>
    </div>
  );
}