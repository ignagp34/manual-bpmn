```
(start Successful service)
(timer Service necessary)
System: Check car registration
...

...
System: Check car registration
Is car registered?
No
(finish)

...
System: Check car registration
Is car registered?
Yes
System: Notify owner
Owner: Go to service facility
...

...
Owner: Go to service facility
(deadline 30 days)
System: Issue fine
(finish)

...
Owner: Go to service facility
Mechanic: Enter car problems
//via email
System: Send status update
...

...
System: Send status update
Is repair done?
No
System: Send status update
...

...
System: Send status update
Is repair done?
Yes
Owner: Pay via app
Mechanic: Record successful repair and Pickerl
Mechanic: Enter next service time
(finish)
```