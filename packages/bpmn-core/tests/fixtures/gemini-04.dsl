Builder: Query web shops
//Query for availability, price, and delivery time
Create order list
//Always use cheapest parts
//If not enough parts, split across multiple shops
[Order List]
Order parts
//Parts arrive in random batches +/- 2 days
(receive Parts)
[Parts]
Build
Check stock
What is the stock level?
OK
Finish building
(finish)

Builder: Query web shops
Create order list
[Order List]
Order parts
(receive Parts)
[Parts]
Build
Check stock
What is the stock level?
Below 5
Reorder cheapest parts
Build
Check stock
What is the stock level?
OK
Finish building
(finish)

Builder: Query web shops
Create order list
[Order List]
Order parts
(receive Parts)
[Parts]
Build
Check stock
What is the stock level?
Below 3
Reorder fastest parts
Build
Check stock
What is the stock level?
OK
Finish building
(finish)

Builder: Query web shops
Create order list
[Order List]
Order parts
(receive Parts)
[Parts]
Build
Check stock
What is the stock level?
Zero
send Complaint email to friends
Build
Check stock
What is the stock level?
OK
Finish building
(finish)