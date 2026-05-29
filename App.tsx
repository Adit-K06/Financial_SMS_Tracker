import React, { useEffect, useState, useRef, useCallback } from 'react';
import {
  View, Text, FlatList, StyleSheet, PermissionsAndroid, Platform,
  TouchableOpacity, ActivityIndicator, ScrollView, StatusBar,
  Animated, AppState, AppStateStatus, Image,
} from 'react-native';
import { NativeModules } from 'react-native';
import DebtsScreen from './DebtsScreen';

const SmsReader: any = (NativeModules as any).SmsReader;
const logoImg = require('./assets/logo.png');

// --- TYPES ---
type Transaction = { id: string; type: 'debit' | 'credit'; amount: number; name: string; raw: string; timestamp: Date };
type ListItem = { kind: 'header'; dateLabel: string; key: string } | { kind: 'tx'; tx: Transaction; key: string };
type Tab = 'transactions' | 'debts';

function getTodayMidnight(): number {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate(), 0, 0, 0, 0).getTime();
}

function getDateLabel(date: Date): string {
  const today = new Date();
  const tm = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const dm = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const diff = Math.round((tm - dm) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return date.toLocaleDateString('en-IN', { weekday: 'long', day: '2-digit', month: 'short' });
}

function parseSMS(body: string, id: string, dateMs: number): Transaction | null {
  const t = body.toLowerCase();
  const isDebit = t.includes('debited') || t.includes('debit') || t.includes('spent') || t.includes('paid') || t.includes('sent') || t.includes('withdrawn') || t.includes('dr.');
  const isCredit = t.includes('credited') || t.includes('credit') || t.includes('received') || t.includes('added') || t.includes('cr.');
  if (!isDebit && !isCredit) return null;
  const am = body.match(/(?:rs\.?|inr\.?|₹)\s*([\d,]+(?:\.\d+)?)/i);
  if (!am) return null;
  const amount = parseFloat(am[1].replace(/,/g, ''));
  if (isNaN(amount)) return null;
  let name = 'Unknown Merchant';
  const u = body.match(/info:\s*upi\/[^\/]+\/([^\/]+)/i);
  if (u && u[1].trim().length > 1) { name = u[1].trim(); }
  else {
    const a = body.match(/debited for (?:rs\.?|inr\.?|₹).*?on.*?;\s*(.*?)\s+credited/i);
    const b = body.match(/credited with (?:rs\.?|inr\.?|₹).*?from\s+([A-Za-z0-9\s]+?)(?:\.|\s+UPI|on\s|$|Ref)/i);
    const c = body.match(/towards\s+([A-Za-z0-9\s#\-]+?)\s+(?:for|on|ref|vpa|upi|$)/i);
    const d = body.match(/(?:at|to|from|info:|trf to|transfer to)\s+([A-Za-z0-9\s#\-\/]+?)(?:\.|\s+UPI|on\s|$|Ref)/i);
    if (a) name = a[1].trim();
    else if (b) name = b[1].trim();
    else if (c) name = c[1].trim();
    else if (d && d[1].trim().length > 1) name = d[1].trim();
  }
  if (name.includes('/')) { const p = name.split('/').find(x => x.trim() && !/^\d+$/.test(x) && x.toLowerCase() !== 'upi'); if (p) name = p.trim(); }
  name = name.replace(/\s+/g, ' ').trim();
  if (name.length > 25) name = name.substring(0, 22) + '...';
  return { id: id || Date.now().toString(), type: isDebit ? 'debit' : 'credit', amount, name: name || 'General Transaction', raw: body, timestamp: new Date(dateMs) };
}

function groupByDate(txs: Transaction[]): ListItem[] {
  const items: ListItem[] = [];
  let last = '';
  const sorted = [...txs].sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  for (const tx of sorted) {
    const l = getDateLabel(tx.timestamp);
    if (l !== last) { items.push({ kind: 'header', dateLabel: l, key: `h-${l}` }); last = l; }
    items.push({ kind: 'tx', tx, key: `t-${tx.id}` });
  }
  return items;
}

export default function App() {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [status, setStatus] = useState('Initializing...');
  const [isSyncing, setIsSyncing] = useState(false);
  const [permGranted, setPermGranted] = useState(true); // assume true, check async
  const [activeTab, setActiveTab] = useState<Tab>('transactions');
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const rotateAnim = useRef(new Animated.Value(0)).current;
  const isSyncingRef = useRef(false);
  const permRef = useRef(true);

  useEffect(() => {
    Animated.loop(Animated.sequence([
      Animated.timing(pulseAnim, { toValue: 0.3, duration: 900, useNativeDriver: true }),
      Animated.timing(pulseAnim, { toValue: 1, duration: 900, useNativeDriver: true }),
    ])).start();
  }, []);

  const spin = rotateAnim.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });

  async function checkPerm(): Promise<boolean> {
    if (Platform.OS !== 'android') return false;
    const r = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.READ_SMS);
    if (r) return true;
    const res = await PermissionsAndroid.requestMultiple([PermissionsAndroid.PERMISSIONS.READ_SMS, PermissionsAndroid.PERMISSIONS.RECEIVE_SMS]);
    return res['android.permission.READ_SMS'] === 'granted' && res['android.permission.RECEIVE_SMS'] === 'granted';
  }

  const runSync = useCallback(async (quiet = false) => {
    if (isSyncingRef.current) return;
    isSyncingRef.current = true;
    setIsSyncing(true);
    if (!quiet) {
      Animated.loop(Animated.timing(rotateAnim, { toValue: 1, duration: 1000, useNativeDriver: true })).start();
      setStatus('Scanning SMS inbox...');
    }
    if (!SmsReader) { isSyncingRef.current = false; setIsSyncing(false); return; }
    const midnight = getTodayMidnight();
    SmsReader.list(
      JSON.stringify({ box: 'inbox', maxCount: 200, minDate: midnight }),
      () => { setStatus('Failed to read SMS.'); isSyncingRef.current = false; setIsSyncing(false); rotateAnim.setValue(0); rotateAnim.stopAnimation(); },
      (_c: number, list: string) => {
        const msgs: Array<{ _id: string; body: string; date: number }> = JSON.parse(list);
        const txs = msgs.filter(m => m.date >= midnight).map(m => parseSMS(m.body, m._id, m.date)).filter(Boolean) as Transaction[];
        setTransactions(prev => {
          const pIds = new Set(prev.map(t => t.id));
          const nIds = new Set(txs.map(t => t.id));
          if (txs.some(t => !pIds.has(t.id)) || prev.some(t => !nIds.has(t.id))) return txs;
          return prev;
        });
        isSyncingRef.current = false; setIsSyncing(false);
        rotateAnim.setValue(0); rotateAnim.stopAnimation();
        if (!quiet) setStatus(`Live • ${txs.length} transaction${txs.length !== 1 ? 's' : ''} today`);
      }
    );
  }, []);

  useEffect(() => {
    (async () => {
      const ok = await checkPerm();
      setPermGranted(ok); permRef.current = ok;
      if (!ok) { setStatus('SMS access denied.'); return; }
      runSync(false);
      setStatus('Live • Watching for new transactions...');
      const iv = setInterval(() => { if (permRef.current) runSync(true); }, 30000);
      return () => clearInterval(iv);
    })();
  }, [runSync]);

  useEffect(() => {
    // Re-check permission on foreground too
    const sub = AppState.addEventListener('change', async (s: AppStateStatus) => {
      if (s === 'active') {
        const ok = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.READ_SMS);
        setPermGranted(ok); permRef.current = ok;
        if (ok) runSync(true);
      }
    });
    return () => sub.remove();
  }, [runSync]);

  const totalDebit = transactions.filter(t => t.type === 'debit').reduce((s, t) => s + t.amount, 0);
  const totalCredit = transactions.filter(t => t.type === 'credit').reduce((s, t) => s + t.amount, 0);
  const listItems = groupByDate(transactions);

  return (
    <View style={st.container}>
      <StatusBar barStyle="light-content" backgroundColor="#0c0c0e" />

      {/* ── HEADER ── */}
      <View style={st.safeTop} />
      <View style={st.header}>
        <View style={st.headerLeft}>
          <Image source={logoImg} style={st.logo} />
          <View>
            <Text style={st.title}>FlashPay</Text>
            <View style={st.liveRow}>
              <Animated.View style={[st.liveDot, { opacity: pulseAnim }]} />
              <Text style={st.liveText}>LIVE</Text>
              <Text style={st.liveSub}> • 30s updates</Text>
            </View>
          </View>
        </View>
        <TouchableOpacity style={[st.syncBtn, isSyncing && st.syncBtnActive]} onPress={() => runSync(false)} disabled={isSyncing}>
          <Animated.Text style={[st.syncIcon, isSyncing && { transform: [{ rotate: spin }] }]}>🔄</Animated.Text>
        </TouchableOpacity>
      </View>

      {/* ── STATUS ── */}
      <View style={st.statusBar}>
        {isSyncing && <ActivityIndicator size={12} color="#818cf8" style={{ marginRight: 6 }} />}
        <Text style={st.statusText} numberOfLines={1}>{status}</Text>
      </View>

      {/* ── TAB BAR ── */}
      <View style={st.tabBar}>
        <TouchableOpacity style={[st.tab, activeTab === 'transactions' && st.tabActive]} onPress={() => setActiveTab('transactions')}>
          <Text style={[st.tabText, activeTab === 'transactions' && st.tabTextActive]}>💳 Transactions</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[st.tab, activeTab === 'debts' && st.tabActive]} onPress={() => setActiveTab('debts')}>
          <Text style={[st.tabText, activeTab === 'debts' && st.tabTextActive]}>📋 Debts</Text>
        </TouchableOpacity>
      </View>

      {/* ── CONTENT ── */}
      {activeTab === 'debts' ? <DebtsScreen /> : (
        <ScrollView contentContainerStyle={st.scroll} showsVerticalScrollIndicator={false}>
          {/* Permission Warning - only if NOT granted */}
          {!permGranted && (
            <View style={st.warn}>
              <Text style={{ fontSize: 22 }}>⚠️</Text>
              <View style={{ flex: 1 }}>
                <Text style={st.warnTitle}>SMS Permission Required</Text>
                <Text style={st.warnBody}>Please grant SMS permission in Android Settings to read bank transactions.</Text>
              </View>
            </View>
          )}

          {/* Metric Cards */}
          <View style={st.metricRow}>
            <View style={[st.metricCard, { borderTopColor: '#f43f5e' }]}>
              <Text style={st.metricEmoji}>💸</Text>
              <Text style={st.metricLabel}>TOTAL SPENT</Text>
              <Text style={[st.metricVal, { color: '#f43f5e' }]}>₹{totalDebit.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</Text>
              <Text style={st.metricSub}>{transactions.filter(t => t.type === 'debit').length} debits today</Text>
            </View>
            <View style={[st.metricCard, { borderTopColor: '#10b981' }]}>
              <Text style={st.metricEmoji}>💰</Text>
              <Text style={st.metricLabel}>TOTAL RECEIVED</Text>
              <Text style={[st.metricVal, { color: '#10b981' }]}>₹{totalCredit.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</Text>
              <Text style={st.metricSub}>{transactions.filter(t => t.type === 'credit').length} credits today</Text>
            </View>
          </View>

          {/* Section Header */}
          <View style={st.secRow}>
            <Text style={st.secTitle}>Today's Transactions</Text>
            <View style={st.pill}><Text style={st.pillText}>{transactions.length}</Text></View>
          </View>

          {/* Transaction List */}
          {listItems.length === 0 ? (
            <View style={st.empty}>
              <Text style={{ fontSize: 36, marginBottom: 12 }}>📭</Text>
              <Text style={st.emptyTitle}>No transactions today</Text>
              <Text style={st.emptyBody}>We're monitoring your SMS inbox from this morning. Bank transaction messages will appear here automatically.</Text>
            </View>
          ) : (
            <FlatList data={listItems} scrollEnabled={false} keyExtractor={i => i.key} renderItem={({ item }) => {
              if (item.kind === 'header') return (
                <View style={st.dateDivider}>
                  <View style={st.dateLine} />
                  <View style={st.datePill}><Text style={st.datePillText}>{item.dateLabel}</Text></View>
                  <View style={st.dateLine} />
                </View>
              );
              const tx = item.tx; const isD = tx.type === 'debit';
              return (
                <View style={[st.txCard, { borderLeftColor: isD ? '#f43f5e' : '#10b981' }]}>
                  <View style={st.txRow}>
                    <View style={[st.txIconW, { backgroundColor: isD ? '#3b0718' : '#052e16' }]}>
                      <Text style={st.txIconT}>{isD ? '↑' : '↓'}</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={st.txName}>{tx.name}</Text>
                      <Text style={st.txTime}>{tx.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</Text>
                    </View>
                    <Text style={[st.txAmt, { color: isD ? '#f43f5e' : '#10b981' }]}>{isD ? '−' : '+'} ₹{tx.amount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</Text>
                  </View>
                  <View style={st.rawW}><Text style={st.rawT} numberOfLines={2}>{tx.raw}</Text></View>
                </View>
              );
            }} />
          )}
        </ScrollView>
      )}
    </View>
  );
}

const st = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0c0c0e' },
  safeTop: { height: Platform.OS === 'android' ? StatusBar.currentHeight || 40 : 52, backgroundColor: '#0c0c0e' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: '#18181b' },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  logo: { width: 40, height: 40, borderRadius: 10 },
  title: { fontSize: 22, fontWeight: '800', color: '#fff', letterSpacing: -0.5 },
  liveRow: { flexDirection: 'row', alignItems: 'center', marginTop: 2 },
  liveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#10b981', marginRight: 4 },
  liveText: { fontSize: 9, fontWeight: '800', color: '#10b981', letterSpacing: 1 },
  liveSub: { fontSize: 9, fontWeight: '500', color: '#52525b' },
  syncBtn: { backgroundColor: '#18181b', borderWidth: 1, borderColor: '#27272a', paddingVertical: 8, paddingHorizontal: 12, borderRadius: 10 },
  syncBtnActive: { borderColor: '#4f46e5', backgroundColor: '#1e1b4b' },
  syncIcon: { fontSize: 16 },
  statusBar: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#111113', borderBottomWidth: 1, borderBottomColor: '#18181b', paddingHorizontal: 16, paddingVertical: 7 },
  statusText: { color: '#71717a', fontSize: 11, fontWeight: '500', flex: 1 },
  tabBar: { flexDirection: 'row', backgroundColor: '#111113', paddingHorizontal: 16, paddingBottom: 2, gap: 4, borderBottomWidth: 1, borderBottomColor: '#1a1a1f' },
  tab: { flex: 1, paddingVertical: 10, alignItems: 'center', borderRadius: 8, marginBottom: 4 },
  tabActive: { backgroundColor: '#1e1b4b', borderWidth: 1, borderColor: '#4f46e5' },
  tabText: { fontSize: 13, fontWeight: '600', color: '#52525b' },
  tabTextActive: { color: '#a5b4fc' },
  scroll: { padding: 16, paddingBottom: 50 },
  warn: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#1c1108', borderWidth: 1, borderColor: '#854d0e', borderRadius: 14, padding: 14, marginBottom: 16 },
  warnTitle: { fontSize: 13, fontWeight: '700', color: '#fbbf24', marginBottom: 2 },
  warnBody: { fontSize: 11, color: '#a16207', lineHeight: 15 },
  metricRow: { flexDirection: 'row', gap: 12, marginBottom: 20 },
  metricCard: { flex: 1, backgroundColor: '#16161a', borderWidth: 1, borderColor: '#22222b', borderRadius: 18, padding: 14, borderTopWidth: 3 },
  metricEmoji: { fontSize: 20, marginBottom: 6 },
  metricLabel: { fontSize: 10, fontWeight: '700', color: '#71717a', letterSpacing: 0.5, marginBottom: 4 },
  metricVal: { fontSize: 17, fontWeight: '800', marginBottom: 4 },
  metricSub: { fontSize: 10, color: '#3f3f46', fontWeight: '500' },
  secRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 12, gap: 8 },
  secTitle: { fontSize: 16, fontWeight: '800', color: '#fff' },
  pill: { backgroundColor: '#27272a', borderRadius: 100, paddingHorizontal: 8, paddingVertical: 2 },
  pillText: { fontSize: 11, fontWeight: '700', color: '#a1a1aa' },
  dateDivider: { flexDirection: 'row', alignItems: 'center', marginVertical: 14, gap: 8 },
  dateLine: { flex: 1, height: 1, backgroundColor: '#1e1e24' },
  datePill: { backgroundColor: '#1a1a22', borderRadius: 100, paddingHorizontal: 12, paddingVertical: 4, borderWidth: 1, borderColor: '#2e2e3a' },
  datePillText: { fontSize: 11, fontWeight: '700', color: '#6366f1', letterSpacing: 0.3 },
  empty: { backgroundColor: '#16161a', borderWidth: 1, borderColor: '#22222b', borderRadius: 18, padding: 32, alignItems: 'center' },
  emptyTitle: { fontSize: 15, fontWeight: '700', color: '#e4e4e7', marginBottom: 6, textAlign: 'center' },
  emptyBody: { fontSize: 12, color: '#52525b', textAlign: 'center', lineHeight: 17 },
  txCard: { backgroundColor: '#16161a', borderWidth: 1, borderColor: '#22222b', borderRadius: 14, padding: 14, marginBottom: 8, borderLeftWidth: 3 },
  txRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  txIconW: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  txIconT: { fontSize: 16, fontWeight: '900', color: '#fff' },
  txName: { fontSize: 14, fontWeight: '700', color: '#f4f4f5' },
  txTime: { fontSize: 11, color: '#52525b', marginTop: 2, fontWeight: '500' },
  txAmt: { fontSize: 15, fontWeight: '800', textAlign: 'right' },
  rawW: { marginTop: 10, backgroundColor: '#111113', borderRadius: 8, padding: 8, borderWidth: 1, borderColor: '#1e1e24' },
  rawT: { fontSize: 10, color: '#3f3f46', lineHeight: 13.5 },
});