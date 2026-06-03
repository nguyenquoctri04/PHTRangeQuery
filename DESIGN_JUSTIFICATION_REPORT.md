# A Report Justifying Design Choices Using Distributed Database Theory

## 1. Design Overview

The system is designed to address range queries in a peer-to-peer distributed data environment. Sensor temperature data is not stored in a centralized database. Instead, it is distributed across multiple peers. Each peer can store local data, participate in routing, process queries, maintain distributed index nodes, and serve replicated data.

The main objective is to demonstrate that a standard Distributed Hash Table is suitable for exact key lookups, but inefficient for range queries. To overcome this limitation, the system implements a Prefix Hash Tree on top of a Chord DHT. This allows range queries to be processed by grouping ordered values through binary prefixes.

## 2. Peer-to-Peer Architecture

The system uses a peer-to-peer architecture instead of a centralized client/server design. In this model, peers have equivalent responsibilities. Each peer can receive requests, route requests, store records, store PHT nodes, serve queries, and hold replicas.

The `bootstrap-node` is only used to help peers join the system initially. After the peers have joined the Chord ring, routing and query processing are performed directly among peers. This design avoids dependency on a central database server and matches the goal of simulating a peer-to-peer distributed data management system.

## 3. Chord DHT as the Routing and Data Location Layer

Chord DHT is used as the base layer for locating data. Each peer has a hash identifier on an 8-bit Chord ring. Different objects in the system are also mapped to the ring through hashing:

- `hash(peerId)`: places a peer on the Chord ring.
- `hash(recordKey)`: identifies the peer responsible for a primary record.
- `hash("temp:" + temperature)`: identifies the peer responsible for an exact-temperature index entry.
- `hash(prefix)`: identifies the peer responsible for a PHT node.

The `find_successor(id)` mechanism allows the system to locate the responsible peer for any key. Because of this, the system does not need a centralized metadata server. Data location is handled in a distributed way through Chord successors, predecessors, and finger tables.

## 4. Distribution Transparency

A key requirement in distributed data systems is hiding the physical location of data from users. This system provides location transparency at the API level. A user only needs to send a request to any peer, for example `peer1`, through endpoints such as:

- `/insert`
- `/query/pht`
- `/query/points`
- `/query/compare`

The user does not need to know which peer stores a record, an exact-temperature index entry, or a PHT node. The receiving peer routes the request to the correct owner peer using Chord.

## 5. The Limitation of DHT for Range Queries

A DHT is designed for exact key lookup. Once a key is hashed, the natural ordering of the original data is lost. Therefore, nearby temperature values such as 20, 21, 22, and 23 may be mapped to completely different positions on the Chord ring.

This creates a clear limitation for range queries. A query such as:

```text
temperature BETWEEN 20 AND 25
```

cannot be answered with a single DHT lookup. If only a standard DHT is used, the system must decompose the query into multiple exact lookups:

```text
temp:20
temp:21
temp:22
temp:23
temp:24
temp:25
```

This approach returns correct results, but its cost increases with the number of values in the queried range. For wide ranges, the number of lookups and logical messages grows quickly.

## 6. Prefix Hash Tree Design

A Prefix Hash Tree is used to add range-query support to the Chord DHT. Instead of directly hashing temperature values and losing their order, the system encodes each temperature value as a 7-bit binary string:

```text
shifted = temperature + 20
binary = shifted.toString(2).padStart(7, "0")
```

The supported temperature domain is:

```text
-20 -> 50
```

After shifting the domain by `temperature + 20`, each value is represented as a fixed-length binary string. Values that are close in the temperature domain are likely to share common prefixes. The PHT uses this property to group data by prefix and support range queries more efficiently.

## 7. Distributing the PHT over Chord

Each PHT node represents a binary prefix. The root node has an empty prefix. When a leaf node contains more than `MAX_BUCKET_SIZE = 10` records, it is split into two child nodes:

```text
prefix + "0"
prefix + "1"
```

The owner of each PHT node is determined through Chord:

```text
find_successor(hash(prefix))
```

This prevents the PHT from being stored on a single peer. PHT nodes are distributed across multiple peers based on prefix hashes. During a range query, the system visits only the PHT nodes whose intervals overlap the requested range and contacts only the peers that store those relevant prefixes.

This design combines two advantages:

- Chord handles routing and owner lookup.
- PHT preserves the logical ordering of the `temperature` attribute.

## 8. Distributed Query Processing

The system supports two range-query processing strategies for comparison.

The first strategy is individual DHT point lookups. For a range `[min, max]`, the system iterates over every temperature value in the range, creates a key in the form `temp:{temperature}`, finds the owner through Chord, and retrieves matching records from the exact-temperature index.

The second strategy is PHT range query. The system starts from the root PHT node, checks the interval represented by each prefix, and only continues to nodes that may contain data in the requested range. When a matching leaf node is reached, the system retrieves records from that node and filters them using:

```text
min <= temperature <= max
```

These two strategies make it possible to evaluate the effectiveness of PHT against a DHT-based baseline.

## 9. Exact-Temperature Index as the Baseline

The system builds an exact-temperature index using keys in the form:

```text
temp:{temperature}
```

This index is not intended to be the optimized solution for range queries. It is used as a baseline to simulate how a standard DHT handles range queries when no order-preserving index is available: the range is decomposed into multiple exact point lookups.

This baseline is appropriate because it reflects the natural strengths and weaknesses of a DHT:

- DHTs are efficient for exact lookups.
- DHTs are inefficient for range queries without an additional indexing structure.

## 10. Replication and Fault Tolerance

The system uses replication factor = 2. Each primary record, exact-temperature index entry, and PHT node is replicated to the successor peer of the primary owner.

This replication strategy improves data availability when a peer fails. If the primary owner of a PHT prefix does not respond, the system can try to read a replica from known peers. This provides a basic level of fault tolerance suitable for an academic demo.

The system does not use full replication because full replication would significantly increase storage cost and update cost. Instead, partial replication to the successor peer provides a practical balance between simplicity, overhead, and fault tolerance.

## 11. Replication Trade-Offs

Replication improves availability, but it also increases write cost. When inserting a record, the system must:

- store the primary record;
- replicate the record to the successor;
- update the exact-temperature index;
- replicate the temperature index entry;
- insert the record into the PHT;
- replicate the PHT node if it is stored or updated.

Since the main workload of this project is dataset loading followed by read-heavy range-query benchmarking, this replication cost is acceptable. If the system were extended to support update-heavy workloads or high concurrent writes, stronger replica consistency control would be required.

## 12. Chord Ring Maintenance

Peers maintain the Chord ring using the following mechanisms:

- `stabilize()` periodically updates successor and predecessor relationships.
- `notify()` allows peers to announce predecessor relationships.
- `fix_fingers()` refreshes finger table entries.
- `repairSuccessorFromFingers()` selects a new successor when the current successor fails.

These mechanisms prevent the overlay network from depending only on its initial state. When peer failure or stale routing information occurs, the system can perform basic self-adjustment.

## 13. Local JSON Storage

Each peer stores data in local JSON files:

```text
storage/peerX/data.json
storage/peerX/pht.json
```

This design is chosen to make distributed data placement and indexing easy to observe. JSON storage allows the primary data, replicas, exact-temperature index, and PHT nodes of each peer to be inspected directly.

This storage method is suitable for an academic demonstration, but it is not optimal for a production system. In a real deployment, JSON files could be replaced by SQLite, PostgreSQL, RocksDB, or another storage engine with stronger concurrency and durability support.

## 14. Evaluation Metrics

The system measures the following metrics:

- `resultsCount`: number of records returned.
- `peersContacted`: number of peers contacted.
- `messagesSent`: number of logical messages.
- `queryHops`: total Chord routing hops.
- `latencyMs`: query latency.
- `coveringPrefixes`: PHT prefixes used to answer the query.

These metrics are appropriate for evaluating a distributed query system because query efficiency depends not only on latency, but also on how many peers are contacted and how much communication is required.

## 15. Experimental Results

For the narrow range `20 -> 25`:

```text
Individual point lookups:
- resultsCount: 224
- peersContacted: 3
- messagesSent: 12
- queryHops: 18
- latencyMs: 19

PHT query:
- resultsCount: 224
- peersContacted: 3
- messagesSent: 6
- queryHops: 48
- latencyMs: 23
```

The PHT query returns the same number of results as the baseline, while reducing logical messages from 12 to 6.

For the wide range `-10 -> 40`:

```text
Individual point lookups:
- resultsCount: 907
- peersContacted: 5
- messagesSent: 102
- queryHops: 152
- latencyMs: 99

PHT query:
- resultsCount: 907
- peersContacted: 4
- messagesSent: 8
- queryHops: 234
- latencyMs: 134
```

The PHT query again returns the same number of results, while reducing logical messages from 102 to 8 and reducing contacted peers from 5 to 4.

## 16. Result Analysis

The results show that PHT is more efficient than the DHT baseline in terms of logical messages. This is especially clear for the wide range, where the baseline performs 51 point lookups for values from -10 to 40. In contrast, the PHT query only visits the relevant prefix leaves.

However, the `queryHops` value for PHT can be higher than the baseline. This happens because each prefix lookup still needs to be routed through the Chord ring. Therefore, PHT reduces the number of logical lookups, but the total number of routing hops may increase depending on where prefix owners are located on the ring.

This reflects a reasonable trade-off:

- PHT reduces logical queries and messages.
- Chord routing still adds hop cost for each prefix lookup.
- Overall performance depends on PHT structure, data distribution, and finger table state.

## 17. System Limitations

The current system focuses on range queries over a DHT. It does not implement all components of a production-grade distributed DBMS. The main limitations are:

- No SQL query processor.
- No transaction manager.
- No complete concurrency control.
- No atomic commit protocol.
- No recovery log.
- No strong replica consistency protocol.
- JSON storage is not suitable for high write concurrency.

These limitations do not invalidate the project goal, because the main scope is to demonstrate the effectiveness of PHT for range queries in a peer-to-peer distributed environment.

## 18. Conclusion

The design choices of this system are appropriate for building a peer-to-peer distributed data model for range queries. Chord DHT provides distributed routing and data location. The exact-temperature index creates a suitable baseline for DHT point lookups. The Prefix Hash Tree adds range-query capability by preserving the logical ordering of the `temperature` attribute through binary prefixes.

Replication to successor peers improves basic fault tolerance without making the system overly complex. The experimental results show that PHT returns the same results as the baseline while significantly reducing logical messages, especially for wider range queries. Therefore, the current design is suitable for an academic project that demonstrates and evaluates range-query processing in a peer-to-peer distributed data system.
