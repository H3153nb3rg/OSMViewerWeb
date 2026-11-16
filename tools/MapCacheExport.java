// One-time migration of the legacy OSMViewer tile cache (Berkeley DB JE,
// MapCache/db-<store>/*.jdb) into plain z/x/y image files that OSMViewer Web
// (and almost every other map tool) can read.
//
// Reads the databases strictly read-only via the DPL RawStore API, so the old
// Java classes are not needed. Requires a JDK >= 11 (source-file launch) and the
// je jar of the legacy project:
//
//   java -cp <OSMViewer>\lib\je-4.0.103.jar MapCacheExport.java <MapCache-Ordner> [Ziel] [Store ...]
//
//   Ordner   e.g. %APPDATA%\JF\OSMViewer\MapCache
//   Ziel     default: <MapCache-Ordner>\tiles
//   Store    store names without "db-" (default: all), e.g. "OpenTopoMap" "My Topo"
//
// Existing files are skipped, so the export can be interrupted and resumed.
import com.sleepycat.je.Environment;
import com.sleepycat.je.EnvironmentConfig;
import com.sleepycat.persist.EntityCursor;
import com.sleepycat.persist.StoreConfig;
import com.sleepycat.persist.raw.RawObject;
import com.sleepycat.persist.raw.RawStore;
import com.sleepycat.persist.raw.RawType;
import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;

public class MapCacheExport {

    public static void main(String[] args) throws Exception {
        if (args.length < 1) {
            System.err.println("Aufruf: java -cp je-4.0.103.jar MapCacheExport.java <MapCache-Ordner> [Ziel] [Store ...]");
            System.exit(1);
        }
        File cache = new File(args[0]);
        File target = args.length > 1 ? new File(args[1]) : new File(cache, "tiles");
        List<String> only = args.length > 2 ? Arrays.asList(args).subList(2, args.length) : List.of();
        File[] dirs = cache.listFiles((d, n) -> n.startsWith("db-") && new File(d, n).isDirectory());
        if (dirs == null) throw new IOException("Kein Verzeichnis: " + cache);
        Arrays.sort(dirs);
        long total = 0;
        for (File dir : dirs) {
            String store = dir.getName().substring(3);
            if (!only.isEmpty() && !only.contains(store)) continue;
            total += exportStore(dir, new File(target, safeName(store)), store);
        }
        System.out.printf(Locale.ROOT, "Fertig: %d Kacheln nach %s%n", total, target);
    }

    static String safeName(String s) {
        return s.replaceAll("[^A-Za-z0-9._ -]", "_").trim();
    }

    static long exportStore(File dbDir, File outDir, String name) {
        File[] logs = dbDir.listFiles((d, n) -> n.endsWith(".jdb"));
        if (logs == null || logs.length == 0) {
            System.out.printf("%-34s leer%n", name);
            return 0;
        }
        EnvironmentConfig envConfig = new EnvironmentConfig();
        envConfig.setReadOnly(true);
        envConfig.setAllowCreate(false);
        envConfig.setTransactional(false);
        envConfig.setLocking(false);
        StoreConfig storeConfig = new StoreConfig();
        storeConfig.setReadOnly(true);
        storeConfig.setAllowCreate(false);
        storeConfig.setTransactional(false);
        long written = 0, skipped = 0, failed = 0;
        Environment env = null;
        RawStore raw = null;
        try {
            env = new Environment(dbDir, envConfig);
            raw = new RawStore(env, "TilesEntityStore", storeConfig);
            String entity = null;
            for (String cls : raw.getModel().getKnownClasses()) {
                RawType t = raw.getModel().getRawType(cls);
                if (t != null && t.getClassMetadata() != null && t.getClassMetadata().isEntityClass() && cls.endsWith("TileDbEntry")) entity = cls;
            }
            if (entity == null) {
                System.out.printf("%-34s keine Kachel-Entitaet gefunden%n", name);
                return 0;
            }
            EntityCursor<RawObject> c = raw.getPrimaryIndex(entity).entities(); // JE 4 cursors are not AutoCloseable
            try {
                for (RawObject o : c) {
                    try {
                        RawObject key = (RawObject) field(o, "tileKey");
                        int z = ((Number) field(key, "zoom")).intValue();
                        int x = ((Number) field(key, "x")).intValue();
                        int y = ((Number) field(key, "y")).intValue();
                        byte[] data = bytes(field(o, "data"));
                        if (data == null || data.length == 0) { failed++; continue; }
                        File f = new File(outDir, z + File.separator + x + File.separator + y + "." + extension(data));
                        if (f.exists()) { skipped++; continue; }
                        f.getParentFile().mkdirs();
                        Path tmp = new File(f.getPath() + ".part").toPath();
                        Files.write(tmp, data);
                        Files.move(tmp, f.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
                        if (++written % 20000 == 0) System.out.printf("  %s: %d ...%n", name, written);
                    } catch (RuntimeException | IOException e) {
                        failed++;
                    }
                }
            } finally {
                c.close();
            }
        } catch (Exception e) {
            System.out.printf("%-34s FEHLER: %s%n", name, e);
            return written;
        } finally {
            try { if (raw != null) raw.close(); } catch (Exception ignored) { }
            try { if (env != null) env.close(); } catch (Exception ignored) { }
        }
        System.out.printf("%-34s %8d exportiert, %6d vorhanden, %4d fehlerhaft%n", name, written, skipped, failed);
        return written;
    }

    /** Field lookup through the raw super-class chain. */
    static Object field(RawObject o, String name) {
        for (RawObject r = o; r != null; r = r.getSuper()) {
            if (r.getValues().containsKey(name)) return r.getValues().get(name);
        }
        throw new IllegalStateException("Feld fehlt: " + name);
    }

    /** byte[] is stored either as primitive array or as RawObject array of Bytes. */
    static byte[] bytes(Object v) {
        if (v instanceof byte[]) return (byte[]) v;
        if (v instanceof RawObject && ((RawObject) v).getElements() != null) {
            Object[] e = ((RawObject) v).getElements();
            byte[] b = new byte[e.length];
            for (int i = 0; i < e.length; i++) b[i] = ((Number) e[i]).byteValue();
            return b;
        }
        return null;
    }

    static String extension(byte[] d) {
        if (d.length > 3 && (d[0] & 0xff) == 0x89 && d[1] == 'P' && d[2] == 'N' && d[3] == 'G') return "png";
        if (d.length > 2 && (d[0] & 0xff) == 0xff && (d[1] & 0xff) == 0xd8) return "jpg";
        if (d.length > 3 && d[0] == 'G' && d[1] == 'I' && d[2] == 'F') return "gif";
        if (d.length > 11 && d[0] == 'R' && d[8] == 'W' && d[9] == 'E' && d[10] == 'B') return "webp";
        return "bin";
    }

}
