import React, { useEffect, useState, useRef } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  PermissionsAndroid,
  Platform,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  ScrollView,
  StatusBar,
  Animated,
} from 'react-native';
import { NativeModules } from 'react-native';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const SmsReader: { list: (filter: string, fail: (e: string) => void, success: (count: number, smsList: string) => void) => void } | undefined = (NativeModules as any).SmsReader;
import AsyncStorage from '@react-native-async-storage/async-storage';

// --- TYPES ---
type Transaction = {
  id: string;
  type: 'debit' | 'credit';
  amount: number;
  name: string;
  raw: string;
  timestamp: Date;
  synced: boolean;
};

// --- PARSER ---
function parseSMS(smsBody: string, smsId: string, dateMs: number): Transaction | null {
  const text = smsBody.toLowerCase();

  const isDebit = text.includes('debited') || text.includes('debit') || text.includes('spent') || text.includes('paid');
  const isCredit = text.includes('credited') || text.includes('credit') || text.includes('received');

  if (!isDebit && !isCredit) return null;

  // Match currency amount: Rs. 100, Rs 100, INR 100, Rs.100.00
  const amountMatch = smsBody.match(
    /(?:rs\.?|inr\.?)\s*([\d,]+(?:\.\d+)?)/i
  );

  if (!amountMatch) return null;

  const amount = parseFloat(amountMatch[1].replace(/,/g, ''));
  if (isNaN(amount)) return null;

  let name = 'Unknown Merchant';

  // Pattern A: "... debited for Rs ... on ...; NAME credited"
  const matchA = smsBody.match(/debited for Rs.*?on.*?;\s*(.*?)\s+credited/i);
  if (matchA) {
    name = matchA[1].trim();
  } else {
    // Pattern B: "... credited with Rs ... on ... from NAME. UPI:"
    const matchB = smsBody.match(/credited with Rs.*?from\s+([A-Za-z0-9\s]+?)(?:\.|\s+UPI|on\s|$|Ref)/i);
    if (matchB) {
      name = matchB[1].trim();
    } else {
      // Pattern C: "... towards NAME for/on/Ref"
      const matchC = smsBody.match(/towards\s+([A-Za-z0-9\s#\-]+?)\s+(?:for|on|ref|vpa|upi|$)/i);
      if (matchC) {
        name = matchC[1].trim();
      } else {
        // Generic pattern fallback
        const namePatterns = [
          /(?:at|to|from|info:|trf to|transfer to)\s+([A-Za-z0-9\s#\-]+?)(?:\.|\s+UPI|on\s|$|Ref)/i,
        ];
        for (const pattern of namePatterns) {
          const match = smsBody.match(pattern);
          if (match && match[1].trim().length > 1) {
            name = match[1].trim();
            break;
          }
        }
      }
    }
  }

  // Sanitize name a bit
  name = name
    .replace(/\s+/g, ' ')
    .trim();

  // Limit name length for display elegance
  if (name.length > 25) {
    name = name.substring(0, 22) + '...';
  }

  return {
    id: smsId || Date.now().toString(),
    type: isDebit ? 'debit' : 'credit',
    amount,
    name: name || 'General Transaction',
    raw: smsBody,
    timestamp: new Date(dateMs),
    synced: false,
  };
}

// --- MAIN APP ---
export default function App() {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [status, setStatus] = useState('Initializing tracker...');
  const [backendUrl, setBackendUrl] = useState('https://sms-tracker-backend.onrender.com');
  const [groupJid, setGroupJid] = useState('Financial Sheets');
  
  // Settings Panel State
  const [showSettings, setShowSettings] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  
  // Connection Status States
  const [apiStatus, setApiStatus] = useState<'online' | 'offline' | 'checking'>('checking');
  const [whatsappStatus, setWhatsappStatus] = useState<'connected' | 'disconnected' | 'unreachable'>('unreachable');
  
  // Async Synced Messages ID tracking
  const [syncedIds, setSyncedIds] = useState<string[]>([]);

  // Rotating Sync Animation
  const rotateAnim = useRef(new Animated.Value(0)).current;

  // Initialize
  useEffect(() => {
    loadSettings();
    checkPermissionsAndSync();
    
    // Set up background polling interval (every 15 seconds)
    const interval = setInterval(() => {
      autoSyncOnly();
    }, 15000);

    return () => clearInterval(interval);
  }, []);

  // Set up settings ping on backend changes
  useEffect(() => {
    testBackendConnection();
  }, [backendUrl]);

  const startSyncAnimation = () => {
    Animated.loop(
      Animated.timing(rotateAnim, {
        toValue: 1,
        duration: 1000,
        useNativeDriver: true,
      })
    ).start();
  };

  const stopSyncAnimation = () => {
    rotateAnim.setValue(0);
    rotateAnim.stopAnimation();
  };

  // --- STORAGE CONFIGS ---
  async function loadSettings() {
    try {
      const savedUrl = await AsyncStorage.getItem('@backend_url');
      const savedJid = await AsyncStorage.getItem('@group_jid');
      const savedSyncs = await AsyncStorage.getItem('@synced_ids');

      if (savedUrl) setBackendUrl(savedUrl);
      else setBackendUrl('https://sms-tracker-backend.onrender.com'); // Live cloud default
      if (savedJid) setGroupJid(savedJid);
      else setGroupJid('Financial Sheets'); // Default group
      if (savedSyncs) {
        setSyncedIds(JSON.parse(savedSyncs));
      }
    } catch (e) {
      console.error('Failed to load settings', e);
    }
  }

  async function saveSettings(url: string, jid: string) {
    try {
      await AsyncStorage.setItem('@backend_url', url);
      await AsyncStorage.setItem('@group_jid', jid);
      setStatus('Settings saved successfully!');
      testBackendConnection();
    } catch (e) {
      setStatus('Failed to save settings');
    }
  }

  // --- HEALTH PING ---
  async function testBackendConnection() {
    if (!backendUrl) {
      setApiStatus('offline');
      setWhatsappStatus('unreachable');
      return;
    }

    setApiStatus('checking');
    try {
      const cleanUrl = backendUrl.endsWith('/') ? backendUrl.slice(0, -1) : backendUrl;
      const response = await fetch(`${cleanUrl}/`, { method: 'GET' });
      
      if (response.ok) {
        const data = await response.json();
        setApiStatus('online');
        if (data.whatsapp_status === 'connected') {
          setWhatsappStatus('connected');
        } else if (data.whatsapp_status === 'disconnected') {
          setWhatsappStatus('disconnected');
        } else {
          setWhatsappStatus('unreachable');
        }
      } else {
        setApiStatus('offline');
        setWhatsappStatus('unreachable');
      }
    } catch (error) {
      setApiStatus('offline');
      setWhatsappStatus('unreachable');
    }
  }

  // --- PERMISSIONS AND SYNC ---
  async function requestPermissions(): Promise<boolean> {
    if (Platform.OS !== 'android') return false;

    const results = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.READ_SMS,
      PermissionsAndroid.PERMISSIONS.RECEIVE_SMS,
    ]);

    return (
      results['android.permission.READ_SMS'] === 'granted' &&
      results['android.permission.RECEIVE_SMS'] === 'granted'
    );
  }

  async function checkPermissionsAndSync() {
    const granted = await requestPermissions();
    if (!granted) {
      setStatus('SMS access denied. Please grant permissions in Android Settings.');
      return;
    }
    runSync();
  }

  // --- SYNC WORKER ---
  async function runSync() {
    if (isSyncing) return;
    setIsSyncing(true);
    startSyncAnimation();
    setStatus('Scanning SMS inbox for bank transactions...');

    // Load recent synced IDs from storage first to ensure up-to-date
    let currentSynced = [...syncedIds];
    try {
      const savedSyncs = await AsyncStorage.getItem('@synced_ids');
      if (savedSyncs) {
        currentSynced = JSON.parse(savedSyncs);
        setSyncedIds(currentSynced);
      }
    } catch (e) {
      console.warn(e);
    }

    if (!SmsReader) {
      console.warn('SmsReader native module not available');
      setIsSyncing(false);
      stopSyncAnimation();
      return;
    }

    SmsReader.list(
      JSON.stringify({
        box: 'inbox',
        maxCount: 50,
      }),
      (fail: string) => {
        console.error('SMS list failed:', fail);
        setStatus('Failed to read SMS inbox.');
        setIsSyncing(false);
        stopSyncAnimation();
      },
      async (count: number, smsList: string) => {
        const messages: Array<{ _id: string; body: string; date: number }> =
          JSON.parse(smsList);

        // Parse and filter down to bank transactions
        const parsedList = messages
          .map((msg) => parseSMS(msg.body, msg._id, msg.date))
          .filter(Boolean) as Transaction[];

        // Sync new transactions to backend
        const newlySynced: string[] = [];
        let successCount = 0;

        for (const tx of parsedList) {
          const alreadySynced = currentSynced.includes(tx.id);
          
          if (!alreadySynced) {
            setStatus(`Forwarding ₹${tx.amount} to WhatsApp...`);
            const sent = await forwardToBackend(tx);
            if (sent) {
              newlySynced.push(tx.id);
              tx.synced = true;
              successCount++;
            }
          } else {
            tx.synced = true;
          }
        }

        // Merge newly synced IDs to storage
        if (newlySynced.length > 0) {
          const updatedSyncedIds = [...currentSynced, ...newlySynced];
          setSyncedIds(updatedSyncedIds);
          await AsyncStorage.setItem('@synced_ids', JSON.stringify(updatedSyncedIds));
        }

        setTransactions(parsedList);
        setIsSyncing(false);
        stopSyncAnimation();
        
        if (successCount > 0) {
          setStatus(`Successfully forwarded ${successCount} new transactions!`);
        } else {
          setStatus(`Dashboard synced. Listening for new messages...`);
        }
        
        // Dynamic Health Recheck
        testBackendConnection();
      }
    );
  }

  // Quiet sync for background polling (no heavy UI loading indicators)
  async function autoSyncOnly() {
    if (isSyncing) return;
    
    // Check if permission is granted
    const hasRead = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.READ_SMS);
    if (!hasRead) return;

    let currentSynced = [...syncedIds];
    try {
      const savedSyncs = await AsyncStorage.getItem('@synced_ids');
      if (savedSyncs) currentSynced = JSON.parse(savedSyncs);
    } catch (e) {
      return;
    }

    // Use our custom native SmsReader module (no third-party lib)
    if (!SmsReader) {
      console.warn('SmsReader native module not available (only works on Android device/emulator)');
      return;
    }

    SmsReader.list(
      JSON.stringify({ box: 'inbox', maxCount: 30 }),
      (error: string) => {
        console.warn('SMS read error:', error);
      },
      async (count: number, smsList: string) => {
        const messages = JSON.parse(smsList);
        const parsedList = messages
          .map((msg: any) => parseSMS(msg.body, msg._id, msg.date))
          .filter(Boolean) as Transaction[];

        const newlySynced: string[] = [];
        let didUpdate = false;

        for (const tx of parsedList) {
          const alreadySynced = currentSynced.includes(tx.id);
          if (!alreadySynced) {
            const sent = await forwardToBackend(tx);
            if (sent) {
              newlySynced.push(tx.id);
              tx.synced = true;
              didUpdate = true;
            }
          } else {
            tx.synced = true;
          }
        }

        if (newlySynced.length > 0) {
          const updated = [...currentSynced, ...newlySynced];
          setSyncedIds(updated);
          await AsyncStorage.setItem('@synced_ids', JSON.stringify(updated));
        }

        if (didUpdate || transactions.length !== parsedList.length) {
          setTransactions(parsedList);
        }
      }
    );
  }

  // --- API CALL ---
  async function forwardToBackend(tx: Transaction): Promise<boolean> {
    if (!backendUrl) return false;

    const cleanUrl = backendUrl.endsWith('/') ? backendUrl.slice(0, -1) : backendUrl;
    const targetUrl = `${cleanUrl}/transaction`;

    try {
      const response = await fetch(targetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: tx.type,
          amount: tx.amount,
          name: tx.name,
          timestamp: tx.timestamp.toISOString(),
          to: groupJid || undefined, // Pass custom WhatsApp JID or Group Name
        }),
      });

      return response.ok;
    } catch (error) {
      console.warn(`Sync failed for ${tx.id}:`, error);
      return false;
    }
  }

  // --- CALCULATE STATS ---
  const totalDebit = transactions
    .filter((t) => t.type === 'debit')
    .reduce((sum, t) => sum + t.amount, 0);

  const totalCredit = transactions
    .filter((t) => t.type === 'credit')
    .reduce((sum, t) => sum + t.amount, 0);

  const spin = rotateAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#121214" />
      
      {/* Top Header Section */}
      <View style={styles.headerContainer}>
        <View>
          <Text style={styles.title}>SMS Tracker</Text>
          <View style={styles.statusRow}>
            {/* API Status Badge */}
            <View style={styles.badge}>
              <View style={[styles.dot, apiStatus === 'online' ? styles.dotGreen : apiStatus === 'checking' ? styles.dotYellow : styles.dotRed]} />
              <Text style={styles.badgeText}>API: {apiStatus.toUpperCase()}</Text>
            </View>
            
            {/* WhatsApp Status Badge */}
            <View style={styles.badge}>
              <View style={[styles.dot, whatsappStatus === 'connected' ? styles.dotGreen : whatsappStatus === 'disconnected' ? styles.dotYellow : styles.dotRed]} />
              <Text style={styles.badgeText}>WHATSAPP: {whatsappStatus.toUpperCase()}</Text>
            </View>
          </View>
        </View>

        <TouchableOpacity 
          style={[styles.settingsToggleBtn, showSettings && styles.settingsToggleBtnActive]} 
          onPress={() => setShowSettings(!showSettings)}
        >
          <Text style={styles.settingsBtnText}>{showSettings ? '✕ Close' : '⚙ Config'}</Text>
        </TouchableOpacity>
      </View>

      {/* Main Content */}
      <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
        {/* Dynamic Config Settings Form */}
        {showSettings && (
          <View style={styles.settingsCard}>
            <Text style={styles.settingsTitle}>Server Configuration</Text>
            
            <Text style={styles.inputLabel}>FastAPI Backend URL</Text>
            <TextInput
              style={styles.input}
              placeholder="https://sms-tracker-backend.onrender.com"
              placeholderTextColor="#71717a"
              value={backendUrl}
              onChangeText={setBackendUrl}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Text style={styles.inputHelp}>
              Pre-configured to your live Render cloud backend. Change only if hosting elsewhere.
            </Text>

            <Text style={styles.inputLabel}>WhatsApp Group JID (Optional)</Text>
            <TextInput
              style={styles.input}
              placeholder="Financial Sheets"
              placeholderTextColor="#71717a"
              value={groupJid}
              onChangeText={setGroupJid}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Text style={styles.inputHelp}>
              Pre-configured to forward to "Financial Sheets". The backend auto-finds this group by name.
            </Text>

            <View style={styles.settingsActionRow}>
              <TouchableOpacity 
                style={styles.testBtn} 
                onPress={testBackendConnection}
              >
                <Text style={styles.btnText}>⚡ Test Link</Text>
              </TouchableOpacity>
              <TouchableOpacity 
                style={styles.saveBtn} 
                onPress={() => saveSettings(backendUrl, groupJid)}
              >
                <Text style={styles.saveBtnText}>💾 Save Config</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* Sync Status Banner */}
        <View style={styles.statusBanner}>
          <Text style={styles.statusBannerText} numberOfLines={2}>{status}</Text>
        </View>

        {/* Metrics Grid */}
        <View style={styles.metricGrid}>
          {/* Card: Total Debits */}
          <View style={[styles.metricCard, styles.debitCard]}>
            <Text style={styles.metricLabel}>🔴 Total Spent</Text>
            <Text style={styles.metricValue}>₹{totalDebit.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</Text>
            <View style={styles.metricLine} />
          </View>
          
          {/* Card: Total Credits */}
          <View style={[styles.metricCard, styles.creditCard]}>
            <Text style={styles.metricLabel}>🟢 Total Received</Text>
            <Text style={styles.metricValue}>₹{totalCredit.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</Text>
            <View style={styles.metricLine} />
          </View>
        </View>

        {/* Sync Trigger button */}
        <TouchableOpacity 
          style={styles.syncButton} 
          onPress={runSync}
          disabled={isSyncing}
        >
          <Animated.View style={isSyncing ? { transform: [{ rotate: spin }] } : {}}>
            <Text style={styles.syncIcon}>🔄</Text>
          </Animated.View>
          <Text style={styles.syncButtonText}>
            {isSyncing ? 'Syncing Transactions...' : 'Sync Transactions Now'}
          </Text>
        </TouchableOpacity>

        {/* Transactions list header */}
        <View style={styles.listHeaderRow}>
          <Text style={styles.listSectionTitle}>Transactions List</Text>
          <Text style={styles.listSectionCount}>{transactions.length} detected</Text>
        </View>

        {/* Transactions FlatList Container */}
        <FlatList
          data={transactions}
          scrollEnabled={false} // Nested inside ScrollView
          keyExtractor={(item) => item.id}
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Text style={styles.emptyIcon}>📂</Text>
              <Text style={styles.emptyText}>No financial transactions found in recent messages.</Text>
              <Text style={styles.emptySubtext}>We scan for keywords like spent, debited, credited, received, and Rs./INR.</Text>
            </View>
          }
          renderItem={({ item }) => (
            <View style={[styles.txCard, item.type === 'debit' ? styles.txDebitBorder : styles.txCreditBorder]}>
              <View style={styles.txRow}>
                <View style={styles.txLeft}>
                  <Text style={styles.txMerchant}>{item.name}</Text>
                  <Text style={styles.txTime}>
                    {item.timestamp.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })} • {item.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </Text>
                </View>
                
                <View style={styles.txRight}>
                  <Text style={[styles.txAmount, item.type === 'debit' ? styles.txDebitColor : styles.txCreditColor]}>
                    {item.type === 'debit' ? '-' : '+'} ₹{item.amount.toFixed(2)}
                  </Text>
                  
                  {/* Sync Status Badge */}
                  <View style={[styles.syncBadge, item.synced ? styles.syncBadgeDone : styles.syncBadgeLocal]}>
                    <Text style={[styles.syncBadgeText, item.synced ? styles.syncBadgeTextDone : styles.syncBadgeTextLocal]}>
                      {item.synced ? '✓ WA PUSHED' : '⧗ LOCAL ONLY'}
                    </Text>
                  </View>
                </View>
              </View>

              {/* Collapsed Raw Details */}
              <View style={styles.rawContainer}>
                <Text style={styles.rawText} numberOfLines={2}>
                  {item.raw}
                </Text>
              </View>
            </View>
          )}
        />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0c0c0e',
    paddingTop: Platform.OS === 'ios' ? 50 : 20,
  },
  headerContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingBottom: 15,
    borderBottomWidth: 1,
    borderBottomColor: '#1e1e24',
  },
  title: {
    fontSize: 26,
    fontWeight: '800',
    color: '#ffffff',
    letterSpacing: -0.5,
  },
  statusRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 6,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#16161a',
    borderRadius: 100,
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderWidth: 1,
    borderColor: '#24242b',
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: 5,
  },
  dotGreen: { backgroundColor: '#10b981' },
  dotYellow: { backgroundColor: '#f59e0b' },
  dotRed: { backgroundColor: '#ef4444' },
  badgeText: {
    fontSize: 9,
    fontWeight: '700',
    color: '#a1a1aa',
    letterSpacing: 0.2,
  },
  settingsToggleBtn: {
    backgroundColor: '#1e1e24',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#2d2d38',
  },
  settingsToggleBtnActive: {
    backgroundColor: '#3b0f14',
    borderColor: '#e11d48',
  },
  settingsBtnText: {
    color: '#e4e4e7',
    fontSize: 12,
    fontWeight: '600',
  },
  scrollContent: {
    padding: 20,
    paddingBottom: 40,
  },
  statusBanner: {
    backgroundColor: '#16161a',
    borderWidth: 1,
    borderColor: '#22222b',
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginBottom: 20,
  },
  statusBannerText: {
    color: '#d4d4d8',
    fontSize: 12.5,
    fontWeight: '500',
    textAlign: 'center',
  },
  settingsCard: {
    backgroundColor: '#16161a',
    borderWidth: 1,
    borderColor: '#27272a',
    borderRadius: 16,
    padding: 16,
    marginBottom: 20,
  },
  settingsTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#ffffff',
    marginBottom: 14,
  },
  inputLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#a1a1aa',
    marginBottom: 6,
  },
  inputHelp: {
    fontSize: 10,
    color: '#52525b',
    marginTop: 4,
    marginBottom: 12,
    lineHeight: 13,
  },
  input: {
    backgroundColor: '#0c0c0e',
    color: '#ffffff',
    borderWidth: 1,
    borderColor: '#2d2d38',
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
    fontSize: 13.5,
  },
  settingsActionRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
    marginTop: 10,
  },
  testBtn: {
    backgroundColor: '#18181b',
    paddingVertical: 9,
    paddingHorizontal: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#2d2d30',
  },
  saveBtn: {
    backgroundColor: '#4f46e5',
    paddingVertical: 9,
    paddingHorizontal: 14,
    borderRadius: 10,
  },
  btnText: {
    color: '#d4d4d8',
    fontSize: 12.5,
    fontWeight: '600',
  },
  saveBtnText: {
    color: '#ffffff',
    fontSize: 12.5,
    fontWeight: '600',
  },
  metricGrid: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 20,
  },
  metricCard: {
    flex: 1,
    backgroundColor: '#16161a',
    borderWidth: 1,
    borderColor: '#22222b',
    borderRadius: 16,
    padding: 14,
    position: 'relative',
    overflow: 'hidden',
  },
  debitCard: {
    borderLeftWidth: 4,
    borderLeftColor: '#f43f5e',
  },
  creditCard: {
    borderLeftWidth: 4,
    borderLeftColor: '#10b981',
  },
  metricLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#a1a1aa',
    textTransform: 'uppercase',
  },
  metricValue: {
    fontSize: 18,
    fontWeight: '800',
    color: '#ffffff',
    marginTop: 6,
  },
  metricLine: {
    height: 1,
    width: '100%',
    backgroundColor: '#27272a',
    marginTop: 8,
    opacity: 0.5,
  },
  syncButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#4f46e5',
    paddingVertical: 14,
    borderRadius: 14,
    gap: 8,
    marginBottom: 25,
    shadowColor: '#4f46e5',
    shadowOpacity: 0.3,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  syncIcon: {
    fontSize: 16,
  },
  syncButtonText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '700',
  },
  listHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  listSectionTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: '#ffffff',
  },
  listSectionCount: {
    fontSize: 12,
    color: '#71717a',
    fontWeight: '500',
  },
  emptyContainer: {
    backgroundColor: '#16161a',
    borderWidth: 1,
    borderColor: '#22222b',
    borderRadius: 16,
    padding: 30,
    alignItems: 'center',
  },
  emptyIcon: {
    fontSize: 32,
    marginBottom: 10,
  },
  emptyText: {
    color: '#e4e4e7',
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: 6,
  },
  emptySubtext: {
    color: '#71717a',
    fontSize: 11,
    textAlign: 'center',
    lineHeight: 14,
  },
  txCard: {
    backgroundColor: '#16161a',
    borderWidth: 1,
    borderColor: '#22222b',
    borderRadius: 14,
    padding: 14,
    marginBottom: 10,
  },
  txDebitBorder: {
    borderLeftWidth: 3,
    borderLeftColor: '#f43f5e',
  },
  txCreditBorder: {
    borderLeftWidth: 3,
    borderLeftColor: '#10b981',
  },
  txRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  txLeft: {
    flex: 1,
    paddingRight: 10,
  },
  txMerchant: {
    fontSize: 14,
    fontWeight: '700',
    color: '#ffffff',
  },
  txTime: {
    fontSize: 10.5,
    color: '#71717a',
    marginTop: 4,
  },
  txRight: {
    alignItems: 'flex-end',
  },
  txAmount: {
    fontSize: 15.5,
    fontWeight: '800',
  },
  txDebitColor: { color: '#f43f5e' },
  txCreditColor: { color: '#10b981' },
  syncBadge: {
    borderRadius: 6,
    paddingVertical: 2,
    paddingHorizontal: 6,
    marginTop: 6,
  },
  syncBadgeDone: {
    backgroundColor: '#10b98115',
  },
  syncBadgeLocal: {
    backgroundColor: '#f59e0b15',
  },
  syncBadgeText: {
    fontSize: 8.5,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  syncBadgeTextDone: {
    color: '#10b981',
  },
  syncBadgeTextLocal: {
    color: '#f59e0b',
  },
  rawContainer: {
    backgroundColor: '#0c0c0e',
    borderRadius: 8,
    padding: 8,
    marginTop: 10,
    borderWidth: 1,
    borderColor: '#1e1e24',
  },
  rawText: {
    fontSize: 10,
    color: '#52525b',
    lineHeight: 13,
  },
});